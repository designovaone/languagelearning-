import { eq, inArray, or } from "drizzle-orm";

import * as schema from "@/lib/db/schema";

/**
 * GDPR Art. 15 (access) and Art. 17 (erasure), written at M1 rather than
 * retrofitted (PLAN.md §2, extensibility decision 4).
 *
 * `db` and `now` are parameters, never reached for, so both paths are testable
 * against in-process Postgres with a fixed clock.
 */

/**
 * Every table that stores something about a specific learner, keyed by the
 * column that points at them.
 *
 * This list is the contract `tests/db/gdpr.test.ts` checks against the live
 * schema: add a table with a `user_id` and forget it here, and the test fails.
 * That is the whole point — an export that silently omits a table looks
 * identical to a complete one.
 */
export const DIRECT_USER_TABLES = [
  "profiles",
  "enrollments",
  "cards",
  "reviews",
  "study_sessions",
  "daily_activity",
  "streak_freezes",
  "push_subscriptions",
  "nudge_log",
  "assessments",
  "ai_calls",
  "session",
  "account",
] as const;

/** Tables reached through another row rather than a `user_id` of their own. */
export const INDIRECT_USER_TABLES = [
  "answer_analysis",
  "assessment_items",
] as const;

/**
 * Tables that mention a user but are not "their" data: an invite records who
 * issued and who redeemed it. Listed explicitly so the test can tell
 * "deliberately excluded" from "forgotten".
 */
export const REFERENCE_ONLY_TABLES = ["invites"] as const;

export type UserExport = {
  exportedAt: string;
  userId: string;
  tables: Record<string, unknown[]>;
};

// The Drizzle database type varies by driver (neon-serverless in production,
// PGlite in tests).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export async function exportUserData(
  db: AnyDb,
  userId: string,
  now: Date,
): Promise<UserExport> {
  const [
    user,
    profiles,
    enrollments,
    cards,
    reviews,
    studySessions,
    dailyActivity,
    streakFreezes,
    pushSubscriptions,
    nudgeLog,
    assessments,
    aiCalls,
    sessions,
    accounts,
  ] = await Promise.all([
    db.select().from(schema.user).where(eq(schema.user.id, userId)),
    rowsFor(db, schema.profiles, schema.profiles.userId, userId),
    rowsFor(db, schema.enrollments, schema.enrollments.userId, userId),
    rowsFor(db, schema.cards, schema.cards.userId, userId),
    rowsFor(db, schema.reviews, schema.reviews.userId, userId),
    rowsFor(db, schema.studySessions, schema.studySessions.userId, userId),
    rowsFor(db, schema.dailyActivity, schema.dailyActivity.userId, userId),
    rowsFor(db, schema.streakFreezes, schema.streakFreezes.userId, userId),
    rowsFor(
      db,
      schema.pushSubscriptions,
      schema.pushSubscriptions.userId,
      userId,
    ),
    rowsFor(db, schema.nudgeLog, schema.nudgeLog.userId, userId),
    rowsFor(db, schema.assessments, schema.assessments.userId, userId),
    rowsFor(db, schema.aiCalls, schema.aiCalls.userId, userId),
    rowsFor(db, schema.session, schema.session.userId, userId),
    rowsFor(db, schema.account, schema.account.userId, userId),
  ]);

  // Indirect tables: reached through the rows already collected.
  const reviewIds = reviews.map((r) => r.id as string);
  const assessmentIds = assessments.map((a) => a.id as string);

  const answerAnalysis = reviewIds.length
    ? await db
        .select()
        .from(schema.answerAnalysis)
        .where(inArray(schema.answerAnalysis.reviewId, reviewIds))
    : [];

  const assessmentItems = assessmentIds.length
    ? await db
        .select()
        .from(schema.assessmentItems)
        .where(inArray(schema.assessmentItems.assessmentId, assessmentIds))
    : [];

  return {
    exportedAt: now.toISOString(),
    userId,
    tables: {
      user,
      profiles,
      enrollments,
      cards,
      reviews,
      answer_analysis: answerAnalysis,
      study_sessions: studySessions,
      daily_activity: dailyActivity,
      streak_freezes: streakFreezes,
      push_subscriptions: pushSubscriptions,
      nudge_log: nudgeLog,
      assessments,
      assessment_items: assessmentItems,
      ai_calls: aiCalls,
      session: sessions,
      account: accounts.map(stripSecrets),
    },
  };
}

type Row = Record<string, unknown>;

async function rowsFor(
  db: AnyDb,
  table: AnyDb,
  column: AnyDb,
  userId: string,
): Promise<Row[]> {
  return db.select().from(table).where(eq(column, userId));
}

/** An export is handed to the user; it must not hand them a password hash. */
function stripSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const { password, accessToken, refreshToken, idToken, ...rest } = row;
  void password;
  void accessToken;
  void refreshToken;
  void idToken;
  return rest;
}



/**
 * Hard delete (Art. 17). Deleting the `user` row cascades to everything that
 * references it; the invite rows keep their audit trail with the reference set
 * to null by the foreign key.
 *
 * Returns false when there was nothing to delete, so a caller can answer 404
 * rather than pretending.
 */
export async function hardDeleteUser(
  db: AnyDb,
  userId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(schema.user)
    .where(eq(schema.user.id, userId))
    .returning({ id: schema.user.id });
  return deleted.length > 0;
}

/** Soft delete: keeps the row, marks it gone, stops it appearing anywhere. */
export async function softDeleteUser(
  db: AnyDb,
  userId: string,
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(schema.profiles)
    .set({ deletedAt: now })
    .where(eq(schema.profiles.userId, userId))
    .returning({ userId: schema.profiles.userId });
  return updated.length > 0;
}

/** Invite rows that mention this user at all, for the audit question. */
export async function invitesMentioning(db: AnyDb, userId: string) {
  return db
    .select()
    .from(schema.invites)
    .where(
      or(
        eq(schema.invites.createdBy, userId),
        eq(schema.invites.usedBy, userId),
      ),
    );
}
