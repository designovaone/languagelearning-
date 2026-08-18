import { eq, inArray } from "drizzle-orm";

import {
  answerAnalysis,
  assessmentItems,
  assessments,
  cards,
  dailyActivity,
  reviews,
  streakFreezes,
  studySessions,
} from "@/lib/db/schema";

/**
 * Return one learner to a pre-assessment state (PLAN.md §11, M3).
 *
 * **Why this exists.** A real assessment run seeds FSRS state, so a second run
 * lands on top of the first and neither can be judged. The cheapest validity
 * check a person can perform on a measuring instrument is to use it twice and
 * see whether the two readings agree — and without a way back to zero, the
 * assessment can be taken exactly once per learner, ever.
 *
 * ### The split that matters
 *
 * Progress is deleted. Identity is not. A reset learner logs in with the same
 * password, on the same course, and starts over — that is the difference
 * between this and `DELETE /api/me`.
 *
 * Both lists are exported and checked against the live schema by a test, so a
 * table added later cannot be quietly missed. A reset that leaves progress
 * behind is worse than no reset: the learner looks cleared and the next sitting
 * is scored against stale history.
 */

/** Deleted. Everything a learner accumulates by using the app. */
export const PROGRESS_TABLES = [
  "cards",
  "reviews",
  "study_sessions",
  "daily_activity",
  "streak_freezes",
  "assessments",
  "answer_analysis",
  "assessment_items",
] as const;

/**
 * Kept, deliberately.
 *
 * - `profiles`, `enrollments`, `session`, `account` — identity and access.
 * - `push_subscriptions` — bound to a device, not to progress. Deleting these
 *   would silently stop the learner's reminders, and PLAN.md §13 is explicit
 *   that a dead subscription reports nothing.
 * - `nudge_log` — a record of what was sent; rewriting history to re-send
 *   today's nudge is not part of resetting progress.
 * - `ai_calls` — a spend log. Costs were really incurred.
 */
export const PRESERVED_TABLES = [
  "profiles",
  "enrollments",
  "push_subscriptions",
  "nudge_log",
  "ai_calls",
  "session",
  "account",
] as const;

export type ResetCounts = Record<(typeof PROGRESS_TABLES)[number], number>;

// The Drizzle database type varies by driver (neon-serverless in production,
// PGlite in tests).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** What a reset would delete. Reads only. */
export async function countProgress(db: AnyDb, userId: string): Promise<ResetCounts> {
  const sittings = await db
    .select({ id: assessments.id })
    .from(assessments)
    .where(eq(assessments.userId, userId));
  const sittingIds = sittings.map((s: { id: string }) => s.id);

  const cardRows = await db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.userId, userId));
  const cardIds = cardRows.map((c: { id: string }) => c.id);

  const reviewRows = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(eq(reviews.userId, userId));
  const reviewIds = reviewRows.map((r: { id: string }) => r.id);

  const size = async (rows: Promise<unknown[]>) => (await rows).length;

  return {
    cards: cardIds.length,
    reviews: reviewIds.length,
    study_sessions: await size(
      db.select({ id: studySessions.id }).from(studySessions).where(eq(studySessions.userId, userId)),
    ),
    daily_activity: await size(
      db.select({ userId: dailyActivity.userId }).from(dailyActivity).where(eq(dailyActivity.userId, userId)),
    ),
    streak_freezes: await size(
      db.select({ id: streakFreezes.id }).from(streakFreezes).where(eq(streakFreezes.userId, userId)),
    ),
    assessments: sittingIds.length,
    answer_analysis: reviewIds.length
      ? await size(db.select({ reviewId: answerAnalysis.reviewId }).from(answerAnalysis).where(inArray(answerAnalysis.reviewId, reviewIds)))
      : 0,
    assessment_items: sittingIds.length
      ? await size(db.select({ id: assessmentItems.id }).from(assessmentItems).where(inArray(assessmentItems.assessmentId, sittingIds)))
      : 0,
  };
}

/**
 * Delete every progress row for one learner, in one transaction.
 *
 * Transactional because a half-reset learner — cards gone, assessment kept —
 * looks reset and is not, and the next sitting would be scored against history
 * that no longer matches the cards.
 */
export async function resetLearner(db: AnyDb, userId: string): Promise<ResetCounts> {
  const counts = await countProgress(db, userId);

  await db.transaction(async (tx: AnyDb) => {
    const sittings = await tx
      .select({ id: assessments.id })
      .from(assessments)
      .where(eq(assessments.userId, userId));
    const sittingIds = sittings.map((s: { id: string }) => s.id);

    const reviewRows = await tx
      .select({ id: reviews.id })
      .from(reviews)
      .where(eq(reviews.userId, userId));
    const reviewIds = reviewRows.map((r: { id: string }) => r.id);

    // Children before parents. Both have `onDelete: "cascade"` on their
    // parent, so this is belt and braces — but a cascade is a property of the
    // schema at migration time, and this transaction is the thing that has to
    // be correct if one is ever dropped.
    if (reviewIds.length) {
      await tx.delete(answerAnalysis).where(inArray(answerAnalysis.reviewId, reviewIds));
    }
    if (sittingIds.length) {
      await tx.delete(assessmentItems).where(inArray(assessmentItems.assessmentId, sittingIds));
    }
    await tx.delete(reviews).where(eq(reviews.userId, userId));
    await tx.delete(cards).where(eq(cards.userId, userId));
    await tx.delete(studySessions).where(eq(studySessions.userId, userId));
    await tx.delete(dailyActivity).where(eq(dailyActivity.userId, userId));
    await tx.delete(streakFreezes).where(eq(streakFreezes.userId, userId));
    await tx.delete(assessments).where(eq(assessments.userId, userId));
  });

  return counts;
}
