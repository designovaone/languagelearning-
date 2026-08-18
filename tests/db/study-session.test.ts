import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  buildSession,
  cardIdFor,
  curveFor,
  dayStatus,
  needsAssessment,
} from "@/lib/study/session";

import { closeDb, migratedDb, type TestDatabase } from "./helpers/pglite";
import { seedMinimal, type Seed } from "./helpers/seed";

/**
 * PLAN.md §7.1, against real Postgres.
 *
 * The pure queue logic is covered in `tests/unit/study/queue.test.ts`. What is
 * tested here is the wiring: that the right rows are read, that the card rows
 * a session needs get created, that the daily limits actually bind, and that
 * the boundary/fresh distinction survives the round trip through the database.
 */

const NOW = new Date("2026-08-18T09:00:00.000Z");

async function seedDeck(db: TestDatabase, words: number, timezone = "Europe/Berlin"): Promise<Seed> {
  return seedMinimal(db, { words, timezone });
}

describe("building a session", () => {
  let db: TestDatabase;
  let seed: Seed;

  beforeEach(async () => {
    db = await migratedDb();
    seed = await seedDeck(db, 8);
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("returns null for a learner with no enrollment", async () => {
    await db.delete(schema.enrollments).where(eq(schema.enrollments.userId, seed.userId));
    expect(await buildSession(db, seed.userId, NOW)).toBeNull();
  });

  it("hands over new cards in frequency order", async () => {
    const session = await buildSession(db, seed.userId, NOW);
    expect(session).not.toBeNull();
    expect(session!.cards.length).toBeGreaterThan(0);
    expect(session!.cards.map((card) => card.wordId)).toEqual(seed.wordIds.slice(0, 8));
  });

  it("creates the card rows the session needs, before the learner answers", async () => {
    // The device sends reviews keyed by card id. A row created only when a
    // review arrives would make the idempotency key depend on whether the
    // flush had already partly succeeded.
    const session = await buildSession(db, seed.userId, NOW);
    const rows = await db.select().from(schema.cards).where(eq(schema.cards.userId, seed.userId));
    expect(rows).toHaveLength(session!.cards.length);
    for (const card of session!.cards) {
      expect(rows.some((row) => row.id === card.cardId)).toBe(true);
      expect(card.cardId).toBe(cardIdFor(seed.userId, card.wordId, "recognition"));
    }
  });

  it("does not duplicate card rows when a session is built twice", async () => {
    await buildSession(db, seed.userId, NOW);
    await buildSession(db, seed.userId, NOW);
    const rows = await db.select().from(schema.cards).where(eq(schema.cards.userId, seed.userId));
    expect(rows).toHaveLength(8);
  });

  it("carries the prompt and the accepted answers, so grading needs no network", async () => {
    const session = await buildSession(db, seed.userId, NOW);
    for (const card of session!.cards) {
      expect(card.prompt).toBeTruthy();
      expect(Array.isArray(card.translations)).toBe(true);
      expect(card.translations.length).toBeGreaterThan(0);
    }
  });

  it("opens a study_sessions row only when there is something to study", async () => {
    const withCards = await buildSession(db, seed.userId, NOW);
    expect(withCards!.cards.length).toBeGreaterThan(0);
    expect(await db.select().from(schema.studySessions)).toHaveLength(1);

    // Now suspend everything so the next build comes back empty.
    await db.update(schema.cards).set({ suspended: true });
    await db.delete(schema.words).where(eq(schema.words.courseId, seed.courseId));

    const empty = await buildSession(db, seed.userId, NOW);
    expect(empty!.cards).toEqual([]);
    // Still one. An abandoned "done for today" visit is not a study session,
    // and counting it as one would corrupt every per-session number.
    expect(await db.select().from(schema.studySessions)).toHaveLength(1);
  });

  it("says how many of each kind are in the session", async () => {
    const session = await buildSession(db, seed.userId, NOW);
    const { review, boundary, fresh } = session!.counts;
    expect(review + boundary + fresh).toBe(session!.cards.length);
  });

  it("has no pace baseline until the learner has one", async () => {
    // The fallback path, exercised with the primary absent: this is every
    // learner's first session.
    const session = await buildSession(db, seed.userId, NOW);
    expect(session!.medianMs.recognition).toBeNull();
  });
});

describe("the daily limits actually bind", () => {
  let db: TestDatabase;
  let seed: Seed;

  beforeEach(async () => {
    db = await migratedDb();
    seed = await seedDeck(db, 30);
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("caps new cards at the profile's daily limit", async () => {
    await db
      .update(schema.profiles)
      .set({ dailyNewLimit: 4 })
      .where(eq(schema.profiles.userId, seed.userId));
    const session = await buildSession(db, seed.userId, NOW);
    expect(session!.cards).toHaveLength(4);
  });

  it("counts what was already introduced today against the limit", async () => {
    await db
      .update(schema.profiles)
      .set({ dailyNewLimit: 5 })
      .where(eq(schema.profiles.userId, seed.userId));

    // Three cards already met today: reviews whose state_before was New.
    await db.insert(schema.cards).values(
      seed.wordIds.slice(0, 3).map((wordId) => ({
        id: cardIdFor(seed.userId, wordId, "recognition"),
        userId: seed.userId,
        courseId: seed.courseId,
        wordId,
        exerciseType: "recognition",
        due: new Date(NOW.getTime() + 86_400_000),
        state: 1,
      })),
    );
    await db.insert(schema.reviews).values(
      seed.wordIds.slice(0, 3).map((wordId, index) => ({
        id: `rev_${index}`,
        cardId: cardIdFor(seed.userId, wordId, "recognition"),
        userId: seed.userId,
        wasCorrect: true,
        durationMs: 3000,
        rating: 3,
        stateBefore: 0,
        stabilityBefore: 0,
        difficultyBefore: 0,
        dueBefore: NOW,
        stabilityAfter: 1,
        difficultyAfter: 5,
        scheduledDays: 1,
        elapsedDays: 0,
        reviewedAt: new Date(NOW.getTime() - 3600_000),
        idempotencyKey: `key_${index}`,
      })),
    );

    const session = await buildSession(db, seed.userId, NOW);
    expect(session!.counts.fresh + session!.counts.boundary).toBe(2);
  });

  /**
   * The zone the count is taken in is the learner's, not the server's. Full
   * coverage of that is in `study-activity.tz.test.ts`; this asserts the
   * boundary is respected at all.
   */
  it("does not count yesterday's cards against today's limit", async () => {
    await db
      .update(schema.profiles)
      .set({ dailyNewLimit: 5 })
      .where(eq(schema.profiles.userId, seed.userId));

    await db.insert(schema.cards).values({
      id: cardIdFor(seed.userId, seed.wordIds[0], "recognition"),
      userId: seed.userId,
      courseId: seed.courseId,
      wordId: seed.wordIds[0],
      exerciseType: "recognition",
      due: new Date(NOW.getTime() + 86_400_000),
      state: 1,
    });
    await db.insert(schema.reviews).values({
      id: "rev_yesterday",
      cardId: cardIdFor(seed.userId, seed.wordIds[0], "recognition"),
      userId: seed.userId,
      wasCorrect: true,
      durationMs: 3000,
      rating: 3,
      stateBefore: 0,
      stabilityBefore: 0,
      difficultyBefore: 0,
      dueBefore: NOW,
      stabilityAfter: 1,
      difficultyAfter: 5,
      scheduledDays: 1,
      elapsedDays: 0,
      reviewedAt: new Date("2026-08-17T09:00:00.000Z"),
      idempotencyKey: "key_yesterday",
    });

    const session = await buildSession(db, seed.userId, NOW);
    expect(session!.counts.fresh + session!.counts.boundary).toBe(5);
  });

  it("caps the whole session at the profile's target", async () => {
    await db
      .update(schema.profiles)
      .set({ dailyNewLimit: 30, sessionTargetCards: 7 })
      .where(eq(schema.profiles.userId, seed.userId));
    const session = await buildSession(db, seed.userId, NOW);
    expect(session!.cards).toHaveLength(7);
  });
});

describe("due cards come back", () => {
  let db: TestDatabase;
  let seed: Seed;

  beforeEach(async () => {
    db = await migratedDb();
    seed = await seedDeck(db, 5);
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("includes a review card that is due and excludes one that is not", async () => {
    await db.insert(schema.cards).values([
      {
        id: cardIdFor(seed.userId, seed.wordIds[0], "recognition"),
        userId: seed.userId,
        courseId: seed.courseId,
        wordId: seed.wordIds[0],
        exerciseType: "recognition",
        due: new Date(NOW.getTime() - 1000),
        state: 2,
        stability: 10,
      },
      {
        id: cardIdFor(seed.userId, seed.wordIds[1], "recognition"),
        userId: seed.userId,
        courseId: seed.courseId,
        wordId: seed.wordIds[1],
        exerciseType: "recognition",
        due: new Date(NOW.getTime() + 86_400_000),
        state: 2,
        stability: 10,
      },
    ]);

    const session = await buildSession(db, seed.userId, NOW);
    const reviews = session!.cards.filter((card) => card.kind === "review");
    expect(reviews.map((card) => card.wordId)).toEqual([seed.wordIds[0]]);
  });

  it("never offers a suspended card", async () => {
    // Production and listening cards are created suspended and activate on
    // gating (PLAN.md §4). One escaping into the queue would show a learner an
    // exercise with no audio behind it.
    await db.insert(schema.cards).values({
      id: cardIdFor(seed.userId, seed.wordIds[0], "listening"),
      userId: seed.userId,
      courseId: seed.courseId,
      wordId: seed.wordIds[0],
      exerciseType: "listening",
      due: new Date(NOW.getTime() - 1000),
      state: 2,
      stability: 10,
      suspended: true,
    });
    const session = await buildSession(db, seed.userId, NOW);
    expect(session!.cards.some((card) => card.exerciseType === "listening")).toBe(false);
  });

  it("reports when the next card falls due", async () => {
    const soon = new Date(NOW.getTime() + 3 * 86_400_000);
    await db.insert(schema.cards).values({
      id: cardIdFor(seed.userId, seed.wordIds[0], "recognition"),
      userId: seed.userId,
      courseId: seed.courseId,
      wordId: seed.wordIds[0],
      exerciseType: "recognition",
      due: soon,
      state: 2,
      stability: 10,
    });
    const session = await buildSession(db, seed.userId, NOW);
    expect(session!.nextDue).toBe(soon.toISOString());
  });
});

describe("the probability curve is recovered from the stored sitting", () => {
  let db: TestDatabase;
  let seed: Seed;

  beforeEach(async () => {
    db = await migratedDb();
    seed = await seedDeck(db, 6);
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("is null when the learner has never been assessed", async () => {
    // Not a degraded state. Without a measurement nothing is half-known, and
    // every candidate is correctly labelled `fresh`.
    expect(await curveFor(db, seed.userId, seed.courseId)).toBeNull();
    const session = await buildSession(db, seed.userId, NOW);
    expect(session!.counts.boundary).toBe(0);
  });

  it("is null when a sitting was started but never finished", async () => {
    // `estimated_size is null` is what makes a row an abandoned sitting. This
    // is the same distinction the dashboard makes, and getting it wrong here
    // would mean fitting a curve to no answers.
    await db.insert(schema.assessments).values({
      id: "a_open",
      userId: seed.userId,
      courseId: seed.courseId,
      takenAt: NOW,
    });
    expect(await curveFor(db, seed.userId, seed.courseId)).toBeNull();
  });

  it("refits from the stored items and labels half-known words", async () => {
    await db.insert(schema.assessments).values({
      id: "a_done",
      userId: seed.userId,
      courseId: seed.courseId,
      takenAt: NOW,
      estimatedSize: 3,
      hitRate: 0.5,
      falseAlarmRate: 0,
      correctedScore: 0.5,
      bandCurve: {},
    });
    // Answered known for the common words, unknown for the rare ones.
    await db.insert(schema.assessmentItems).values(
      seed.wordIds.map((wordId, index) => ({
        id: `a_done:${index}`,
        assessmentId: "a_done",
        wordId,
        isReal: true,
        answeredKnown: index < 2,
      })),
    );

    const fit = await curveFor(db, seed.userId, seed.courseId);
    expect(fit).not.toBeNull();
    expect(Number.isFinite(fit!.mu)).toBe(true);
    expect(fit!.s).toBeGreaterThan(0);

    const session = await buildSession(db, seed.userId, NOW);
    // The common words come first and are the ones marked boundary.
    expect(session!.counts.boundary).toBeGreaterThan(0);
    expect(session!.cards[0].kind).toBe("boundary");
  });

  it("ignores a sitting belonging to another learner", async () => {
    const other = await seedMinimal(db, { userId: "u_other", words: 2 });
    await db.insert(schema.assessments).values({
      id: "a_other",
      userId: other.userId,
      courseId: other.courseId,
      takenAt: NOW,
      estimatedSize: 2,
      falseAlarmRate: 0,
    });
    expect(await curveFor(db, seed.userId, seed.courseId)).toBeNull();
  });
});

describe("the drill will not start without an assessment", () => {
  /**
   * **The failure this guards, found by running the drill against the live
   * database rather than by any test.**
   *
   * An unassessed learner's session came back as the five most frequent
   * Italian words: `e` (and), `di` ("used to indicate possession"), `il`
   * (the), `la` (the), `che` (that). Two identical translations and a grammar
   * note where a meaning should be — the entire first impression of the app.
   *
   * Nothing was broken. Those really are the most frequent words, and a deck
   * ordered by frequency really does open on them. The assessment is what
   * fixes it: it seeds every one as known, and the same query for an assessed
   * learner returns `regola`, `cliente`, `volto`, `minimo`.
   *
   * ISSUES.md said "verify that on the first real session rather than
   * assuming it". Verified — and then made structural, because verifying it
   * only proved that the *assessed* path is fine.
   */
  let db: TestDatabase;
  let seed: Seed;

  beforeEach(async () => {
    db = await migratedDb();
    seed = await seedDeck(db, 5);
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("says a never-assessed learner needs one", async () => {
    expect(await needsAssessment(db, seed.userId)).toBe(true);
  });

  it("still says so when a sitting was started and abandoned", async () => {
    await db.insert(schema.assessments).values({
      id: "a_open",
      userId: seed.userId,
      courseId: seed.courseId,
      takenAt: NOW,
    });
    expect(await needsAssessment(db, seed.userId)).toBe(true);
  });

  it("clears once a sitting is finished", async () => {
    await db.insert(schema.assessments).values({
      id: "a_done",
      userId: seed.userId,
      courseId: seed.courseId,
      takenAt: NOW,
      estimatedSize: 100,
      falseAlarmRate: 0,
    });
    expect(await needsAssessment(db, seed.userId)).toBe(false);
  });

  it("is not another learner's sitting", async () => {
    const other = await seedMinimal(db, { userId: "u_other", words: 2 });
    await db.insert(schema.assessments).values({
      id: "a_other",
      userId: other.userId,
      courseId: other.courseId,
      takenAt: NOW,
      estimatedSize: 100,
      falseAlarmRate: 0,
    });
    expect(await needsAssessment(db, seed.userId)).toBe(true);
  });

  it("does not claim an unenrolled learner needs an assessment", async () => {
    // They need a course first. Sending them to the assessment would be a
    // loop: it has nothing to test them on either.
    await db.delete(schema.enrollments).where(eq(schema.enrollments.userId, seed.userId));
    expect(await needsAssessment(db, seed.userId)).toBe(false);
  });
});

describe("the day's status, without opening a session", () => {
  let db: TestDatabase;
  let seed: Seed;

  beforeEach(async () => {
    db = await migratedDb();
    seed = await seedDeck(db, 3);
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("has no side effect on study_sessions", async () => {
    await dayStatus(db, seed.userId, NOW);
    await dayStatus(db, seed.userId, NOW);
    expect(await db.select().from(schema.studySessions)).toHaveLength(0);
  });

  it("counts due cards and reports the next one", async () => {
    await db.insert(schema.cards).values([
      {
        id: cardIdFor(seed.userId, seed.wordIds[0], "recognition"),
        userId: seed.userId,
        courseId: seed.courseId,
        wordId: seed.wordIds[0],
        exerciseType: "recognition",
        due: new Date(NOW.getTime() - 1),
        state: 2,
      },
      {
        id: cardIdFor(seed.userId, seed.wordIds[1], "recognition"),
        userId: seed.userId,
        courseId: seed.courseId,
        wordId: seed.wordIds[1],
        exerciseType: "recognition",
        due: new Date(NOW.getTime() + 86_400_000),
        state: 2,
      },
    ]);
    const status = await dayStatus(db, seed.userId, NOW);
    expect(status.dueNow).toBe(1);
    expect(status.nextDue?.getTime()).toBe(NOW.getTime() - 1);
  });

  it("works for a learner with no profile row at all", async () => {
    // The fallback with the primary absent. A missing profile must not 500 the
    // dashboard; it degrades to the default zone.
    await db.delete(schema.profiles).where(eq(schema.profiles.userId, seed.userId));
    const status = await dayStatus(db, seed.userId, NOW);
    expect(status.cardsDone).toBe(0);
  });
});
