import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  courseFor,
  startAssessment,
  submitAssessment,
} from "@/lib/assessment/service";
import * as schema from "@/lib/db/schema";

import { closeDb, migratedDb, type TestDatabase } from "./helpers/pglite";
import { seedMinimal } from "./helpers/seed";

/**
 * The assessment end to end, against real Postgres (PLAN.md §6).
 *
 * The pure modules are validated against simulated learners elsewhere. What
 * this covers is the part simulation cannot: that the sitting survives the
 * round trip through the database, and — the security property the whole
 * instrument rests on — that **the client is never told which prompts are
 * traps**. If it were, the false-alarm rate would be under the control of the
 * thing being measured, and the correction would become decorative.
 */

const USER = "u_assess";
const NOW = new Date("2026-08-18T09:00:00.000Z");
const PSEUDO = Array.from({ length: 40 }, (_, i) => `zzqfake${i}`);

describe("assessment service", () => {
  let db: TestDatabase;
  let courseId: string;
  let wordIds: string[];

  beforeEach(async () => {
    db = await migratedDb();
    const seed = await seedMinimal(db, { userId: USER, words: 80 });
    courseId = seed.courseId;
    wordIds = seed.wordIds;
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("starts a sitting and returns prompts with no hint of which are real", async () => {
    const started = await startAssessment(db, USER, PSEUDO, NOW, 1);
    expect(started).not.toBeNull();
    expect(started!.items.length).toBeGreaterThan(0);

    for (const item of started!.items) {
      // The wire shape is exactly {index, prompt}. Anything else — isReal, a
      // wordId, a band — would leak the answer key.
      expect(Object.keys(item).sort()).toEqual(["index", "prompt"]);
    }
  });

  it("persists every item before the learner answers", async () => {
    const started = await startAssessment(db, USER, PSEUDO, NOW, 1);
    const stored = await db
      .select()
      .from(schema.assessmentItems)
      .where(eq(schema.assessmentItems.assessmentId, started!.assessmentId));

    expect(stored).toHaveLength(started!.items.length);
    expect(stored.every((row) => row.answeredKnown === null)).toBe(true);
    expect(stored.some((row) => row.isReal)).toBe(true);
    expect(stored.some((row) => !row.isReal)).toBe(true);
  });

  it("scores an honest learner and seeds cards as known", async () => {
    const started = await startAssessment(db, USER, PSEUDO, NOW, 7);
    const stored = await db
      .select()
      .from(schema.assessmentItems)
      .where(eq(schema.assessmentItems.assessmentId, started!.assessmentId));
    const realByIndex = new Map(
      stored.map((row) => [Number(String(row.id).split(":").pop()), row.isReal]),
    );

    // Knows every real word, claims no trap.
    const answers = started!.items.map((item) => ({
      index: item.index,
      answeredKnown: realByIndex.get(item.index) === true,
      durationMs: 900,
    }));

    const result = await submitAssessment(db, USER, started!.assessmentId, answers, NOW);
    expect(result).not.toBeNull();
    expect(result!.hitRate).toBe(1);
    expect(result!.falseAlarmRate).toBe(0);
    expect(result!.correctedScore).toBe(1);
    expect(result!.seeded.known).toBeGreaterThan(0);

    const cards = await db
      .select()
      .from(schema.cards)
      .where(eq(schema.cards.userId, USER));
    expect(cards.length).toBe(result!.seeded.known);
    // State 2 is Review; a seeded card must be due in the future, never now.
    expect(cards.every((card) => card.state === 2)).toBe(true);
    expect(cards.every((card) => card.due.getTime() > NOW.getTime())).toBe(true);
    expect(cards.every((card) => card.stability >= 3 && card.stability <= 21)).toBe(true);
  });

  it("seeds NOTHING for a learner who claims every prompt", async () => {
    // The failure that matters. A deck seeded as entirely known makes
    // thousands of real words invisible for three weeks, and nothing reports
    // it — the learner simply never sees them.
    const started = await startAssessment(db, USER, PSEUDO, NOW, 11);
    const answers = started!.items.map((item) => ({
      index: item.index,
      answeredKnown: true,
      durationMs: 200,
    }));

    const result = await submitAssessment(db, USER, started!.assessmentId, answers, NOW);
    expect(result!.correctedScore).toBe(0);
    expect(result!.seeded.known).toBe(0);
    expect(
      await db.select().from(schema.cards).where(eq(schema.cards.userId, USER)),
    ).toHaveLength(0);
  });

  it("records the answers and the summary on the sitting", async () => {
    const started = await startAssessment(db, USER, PSEUDO, NOW, 3);
    const answers = started!.items.map((item) => ({
      index: item.index,
      answeredKnown: item.index % 2 === 0,
      durationMs: 1500,
    }));
    await submitAssessment(db, USER, started!.assessmentId, answers, NOW);

    const [row] = await db
      .select()
      .from(schema.assessments)
      .where(eq(schema.assessments.id, started!.assessmentId));
    expect(row.estimatedSize).not.toBeNull();
    expect(row.hitRate).not.toBeNull();
    expect(row.falseAlarmRate).not.toBeNull();
    expect(row.bandCurve).not.toBeNull();

    const items = await db
      .select()
      .from(schema.assessmentItems)
      .where(eq(schema.assessmentItems.assessmentId, started!.assessmentId));
    expect(items.every((item) => item.answeredKnown !== null)).toBe(true);
    expect(items.every((item) => item.durationMs === 1500)).toBe(true);
  });

  it("seeds a REAL number of cards for a mid-level learner", async () => {
    // The failure this catches shipped and was found by using the app. A real
    // sitting estimated 4,520 known words and seeded ZERO cards, because
    // seeding read the three-band average and Italian bands are 2,000-3,000
    // words wide — a learner must clear 80% of a whole band before one card is
    // seeded. The estimate and the seeding disagreed completely and the number
    // on screen looked right.
    //
    // Seeding now reads each word's own P(known) from the fitted curve.
    const started = await startAssessment(db, USER, PSEUDO, NOW, 21);
    const stored = await db
      .select()
      .from(schema.assessmentItems)
      .where(eq(schema.assessmentItems.assessmentId, started!.assessmentId));
    const byIndex = new Map(
      stored.map((row) => [Number(String(row.id).split(":").pop()), row]),
    );

    // Knows the common half, claims one trap in ten. Roughly a real learner.
    const answers = started!.items.map((item, i) => {
      const row = byIndex.get(item.index)!;
      const known = row.isReal ? i % 3 !== 0 : i % 10 === 0;
      return { index: item.index, answeredKnown: known };
    });

    const result = await submitAssessment(db, USER, started!.assessmentId, answers, NOW);
    expect(result!.estimatedSize).toBeGreaterThan(0);
    // The core invariant: an estimate above zero must put cards behind it.
    expect(result!.seeded.known).toBeGreaterThan(0);

    const cards = await db.select().from(schema.cards).where(eq(schema.cards.userId, USER));
    expect(cards.length).toBe(result!.seeded.known);
  });

  it("refuses to submit another learner's sitting", async () => {
    await seedMinimal(db, { userId: "u_other", words: 5 });
    const started = await startAssessment(db, USER, PSEUDO, NOW, 5);
    const answers = started!.items.map((item) => ({
      index: item.index,
      answeredKnown: false,
    }));

    expect(
      await submitAssessment(db, "u_other", started!.assessmentId, answers, NOW),
    ).toBeNull();
  });

  it("returns null for a learner enrolled in no course", async () => {
    await db.insert(schema.user).values({
      id: "u_lonely",
      name: "No Course",
      email: "lonely@example.test",
      emailVerified: false,
      updatedAt: NOW,
    });
    expect(await startAssessment(db, "u_lonely", PSEUDO, NOW, 1)).toBeNull();
  });

  it("writes exactly ONE assessment row per start", async () => {
    // The route used to call startAssessment twice - once with an empty pool
    // just to read the course slug - leaving an orphan row on every start. An
    // orphan counts as a sitting anywhere that asks "has this learner been
    // assessed", so opening the page and walking away hid the assessment link.
    await startAssessment(db, USER, PSEUDO, NOW, 1);
    expect(
      await db
        .select()
        .from(schema.assessments)
        .where(eq(schema.assessments.userId, USER)),
    ).toHaveLength(1);
  });

  it("leaves a started-but-unfinished sitting with no estimate", async () => {
    // What makes a sitting *finished* is `estimatedSize`, not the row existing.
    await startAssessment(db, USER, PSEUDO, NOW, 1);
    const [row] = await db
      .select()
      .from(schema.assessments)
      .where(eq(schema.assessments.userId, USER));
    expect(row.estimatedSize).toBeNull();
  });

  it("finds the course without creating anything", async () => {
    const course = await courseFor(db, USER);
    expect(course?.id).toBe(courseId);
    expect(
      await db
        .select()
        .from(schema.assessments)
        .where(eq(schema.assessments.userId, USER)),
    ).toHaveLength(0);
  });

  it("is reproducible: the same seed produces the same prompts", async () => {
    const a = await startAssessment(db, USER, PSEUDO, NOW, 99);
    const b = await startAssessment(db, USER, PSEUDO, NOW, 99);
    expect(a!.items.map((i) => i.prompt)).toEqual(b!.items.map((i) => i.prompt));
  });

  it("uses the course id, not the word count, to decide seeding scope", async () => {
    const started = await startAssessment(db, USER, PSEUDO, NOW, 7);
    const stored = await db
      .select()
      .from(schema.assessmentItems)
      .where(eq(schema.assessmentItems.assessmentId, started!.assessmentId));
    const realByIndex = new Map(
      stored.map((row) => [Number(String(row.id).split(":").pop()), row.isReal]),
    );
    const answers = started!.items.map((item) => ({
      index: item.index,
      answeredKnown: realByIndex.get(item.index) === true,
    }));
    await submitAssessment(db, USER, started!.assessmentId, answers, NOW);

    const cards = await db.select().from(schema.cards).where(eq(schema.cards.userId, USER));
    // Seeding covers the whole deck, not merely the words that were shown.
    expect(cards.length).toBeGreaterThan(started!.items.length);
    expect(cards.every((card) => card.courseId === courseId)).toBe(true);
    expect(cards.every((card) => wordIds.includes(card.wordId as string))).toBe(true);
  });
});
