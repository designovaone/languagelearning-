import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DIRECT_USER_TABLES,
  INDIRECT_USER_TABLES,
} from "@/lib/gdpr/export";
import {
  countProgress,
  PRESERVED_TABLES,
  PROGRESS_TABLES,
  resetLearner,
} from "@/lib/learner/reset";
import * as schema from "@/lib/db/schema";

import { closeDb, migratedDb, type TestDatabase } from "./helpers/pglite";
import { EPOCH, seedMinimal } from "./helpers/seed";

/**
 * PLAN.md §11, M3: the reset script must return a learner to a state where a
 * second assessment behaves exactly like a first.
 *
 * The failure worth guarding is not a crash. It is a reset that runs, reports
 * success, and leaves rows behind — the learner looks cleared, takes the
 * assessment again, and the second reading is scored against history that no
 * longer matches. Every test here is about *completeness*, not mechanics.
 */

const USER = "u_reset";
const OTHER = "u_bystander";

/**
 * Progress rows on top of `seedMinimal`, one per table the reset touches, so a
 * missed table shows up as a leftover row rather than as a passing test.
 */
async function seedProgress(db: TestDatabase, userId: string): Promise<void> {
  const { courseId, wordIds } = await seedMinimal(db, { userId });

  await db.insert(schema.cards).values({
    id: `${userId}-card`,
    userId,
    courseId,
    wordId: wordIds[0],
    exerciseType: "recognition",
    due: EPOCH,
  });
  await db.insert(schema.studySessions).values({
    id: `${userId}-session`,
    userId,
    startedAt: EPOCH,
    localDate: "2026-08-18",
  });
  await db.insert(schema.reviews).values({
    id: `${userId}-review`,
    cardId: `${userId}-card`,
    userId,
    sessionId: `${userId}-session`,
    rating: 3,
    wasCorrect: true,
    durationMs: 1200,
    stateBefore: 0,
    stabilityBefore: 0,
    difficultyBefore: 0,
    dueBefore: EPOCH,
    stabilityAfter: 1,
    difficultyAfter: 5,
    scheduledDays: 1,
    elapsedDays: 0,
    reviewedAt: EPOCH,
    idempotencyKey: `${userId}-idem`,
  });
  await db.insert(schema.answerAnalysis).values({
    reviewId: `${userId}-review`,
    errorType: "none",
    model: "test",
  });
  await db.insert(schema.dailyActivity).values({
    userId,
    localDate: "2026-08-18",
    cardsDone: 10,
  });
  await db.insert(schema.streakFreezes).values({
    id: `${userId}-freeze`,
    userId,
    localDate: "2026-08-17",
  });
  await db.insert(schema.assessments).values({
    id: `${userId}-assessment`,
    userId,
    courseId,
    estimatedSize: 3000,
  });
  await db.insert(schema.assessmentItems).values({
    id: `${userId}-item`,
    assessmentId: `${userId}-assessment`,
    pseudoword: "zzqfake",
    isReal: false,
    answeredKnown: false,
  });
}

describe("resetLearner", () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await migratedDb();
    await seedProgress(db, USER);
    await seedProgress(db, OTHER);
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("counts every progress row before deleting anything", async () => {
    const counts = await countProgress(db, USER);
    for (const table of PROGRESS_TABLES) {
      expect(counts[table], `${table} should have a seeded row`).toBe(1);
    }
    // Counting must not delete. Called twice, the answer is the same.
    expect(await countProgress(db, USER)).toEqual(counts);
  });

  it("leaves no progress row behind", async () => {
    await resetLearner(db, USER);
    const after = await countProgress(db, USER);
    for (const table of PROGRESS_TABLES) {
      expect(after[table], `${table} should be empty after a reset`).toBe(0);
    }
  });

  it("keeps identity: profile, enrollment and the account itself", async () => {
    await resetLearner(db, USER);
    expect(
      await db.select().from(schema.profiles).where(eq(schema.profiles.userId, USER)),
    ).toHaveLength(1);
    expect(
      await db.select().from(schema.enrollments).where(eq(schema.enrollments.userId, USER)),
    ).toHaveLength(1);
  });

  it("does not touch another learner", async () => {
    await resetLearner(db, USER);
    const bystander = await countProgress(db, OTHER);
    for (const table of PROGRESS_TABLES) {
      expect(bystander[table], `${table} of the other learner`).toBe(1);
    }
  });

  it("is idempotent — a second reset is a no-op, not an error", async () => {
    await resetLearner(db, USER);
    await expect(resetLearner(db, USER)).resolves.toBeDefined();
  });

  it("covers every user-owned table in the schema, or names it as preserved", () => {
    // The guard that keeps this correct as the schema grows. Add a table with
    // a user_id, forget it here, and this fails — the same trick the GDPR
    // export uses, for the same reason: a reset that silently skips a table is
    // indistinguishable from a complete one.
    const accounted = new Set<string>([...PROGRESS_TABLES, ...PRESERVED_TABLES]);
    const owned = [...DIRECT_USER_TABLES, ...INDIRECT_USER_TABLES];
    const missing = owned.filter((table) => !accounted.has(table));
    expect(missing, "tables neither reset nor explicitly preserved").toEqual([]);
  });

  it("never lists a table as both deleted and preserved", () => {
    const both = PROGRESS_TABLES.filter((t) =>
      (PRESERVED_TABLES as readonly string[]).includes(t),
    );
    expect(both).toEqual([]);
  });
});
