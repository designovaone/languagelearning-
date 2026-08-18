import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";

import {
  assessmentItems,
  assessments,
  cards,
  courses,
  dailyActivity,
  enrollments,
  profiles,
  reviews,
  studySessions,
  words,
} from "@/lib/db/schema";
import { fitCurve, pKnown, type CurveFit, type FitObservation } from "@/lib/assessment/fit";
import { gradeFor, rollingMedian } from "@/lib/fsrs/grade";
import { applyReview } from "@/lib/fsrs/scheduler";
import { emptyCardState, type CardState } from "@/lib/fsrs/serde";
import { localDate, safeTimeZone } from "@/lib/time/local-date";

import { buildQueue, type NewCandidate, type QueueEntry } from "./queue";

/**
 * The drill, joined up (PLAN.md §7).
 *
 * Everything that decides something lives in the pure modules beside this one —
 * `queue`, `normalize`, and `lib/fsrs/*`. This file does the parts that need a
 * database: read the deck, hand the device a whole session in one request, and
 * write back what came of it.
 *
 * **One request per session, not per card.** Sixty cards at even 150 ms of
 * round trip is ninety seconds of the learner waiting, spread across the
 * session in the exact places where waiting is most noticeable. The prefetch
 * also turns the serverless cold start into a once-per-session cost and makes
 * the drill work in a dead spot, which is where a phone actually gets used.
 *
 * `now` is a parameter throughout, per the clock rule in CLAUDE.md.
 */

// The Drizzle database type varies by driver (Neon in production, PGlite in
// tests). Same schema, different generic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const RECOGNITION = "recognition";

/** How many recent durations the pace baseline is taken over. */
const MEDIAN_WINDOW = 100;

/**
 * A flushed review may arrive long after the session started, but never more
 * than this far after it. Beyond that the offset is not a plausible elapsed
 * time and the server's own clock is the better answer.
 */
const MAX_SESSION_MS = 6 * 60 * 60 * 1000;

export type SessionCard = {
  /** Null never reaches the client: rows are created before the payload is sent. */
  cardId: string;
  wordId: string;
  /** `review` | `boundary` | `fresh` — what the learner is being shown and why. */
  kind: QueueEntry["kind"];
  exerciseType: string;
  prompt: string;
  pos: string | null;
  gender: string | null;
  translations: string[];
  primarySense: string | null;
};

export type StudySession = {
  sessionId: string;
  startedAt: string;
  localDate: string;
  cards: SessionCard[];
  /** The learner's own pace, per exercise type. Null until they have a baseline. */
  medianMs: Record<string, number | null>;
  counts: { review: number; boundary: number; fresh: number };
  /** For the "done for today" screen when the queue comes back empty. */
  today: { cardsDone: number; seconds: number };
  nextDue: string | null;
};

export type ReviewInput = {
  cardId: string;
  idempotencyKey: string;
  wasCorrect: boolean;
  durationMs: number;
  answerGiven: string | null;
  hintUsed: boolean;
  /**
   * Milliseconds since the session started, measured with `performance.now()`.
   *
   * **Not a timestamp.** A device clock can be wrong by hours, and a wrong
   * `reviewed_at` corrupts the streak, the daily limits and the replay order
   * at once. An offset against a server-recorded start is monotonic on the
   * device and anchored on the server, so neither side has to be trusted for
   * something it cannot know.
   */
  offsetMs: number;
};

export type FlushResult = {
  applied: number;
  /** Reviews whose idempotency key had already been written. Not an error. */
  skipped: number;
  today: { cardsDone: number; seconds: number };
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function profileFor(db: AnyDb, userId: string) {
  const rows = await db
    .select({
      timezone: profiles.timezone,
      dailyNewLimit: profiles.dailyNewLimit,
      dailyReviewLimit: profiles.dailyReviewLimit,
      sessionTargetCards: profiles.sessionTargetCards,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

async function courseFor(db: AnyDb, userId: string) {
  const rows = await db
    .select({ id: courses.id })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(and(eq(enrollments.userId, userId), eq(enrollments.active, true)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The learner's probability-of-known curve, refitted from the stored sitting.
 *
 * Refitted rather than stored. The curve's two parameters were never written
 * to `assessments` — only the human-readable band curve was — but every input
 * that produced them is still there in `assessment_items`, so the fit is
 * recoverable exactly. Recomputing costs a grid search over forty binary
 * answers, which is nothing, and it means the learner already assessed does
 * not have to sit the test again for the drill to know what it knows.
 *
 * Null when there is no completed sitting. Every candidate is then `fresh`,
 * which is the honest answer: without a measurement nothing is half-known.
 */
export async function curveFor(
  db: AnyDb,
  userId: string,
  courseId: string,
): Promise<CurveFit | null> {
  const sittings = await db
    .select({ id: assessments.id, falseAlarmRate: assessments.falseAlarmRate })
    .from(assessments)
    .where(
      and(
        eq(assessments.userId, userId),
        eq(assessments.courseId, courseId),
        isNotNull(assessments.estimatedSize),
      ),
    )
    .orderBy(desc(assessments.takenAt))
    .limit(1);
  if (sittings.length === 0) return null;

  const items = await db
    .select({ freqRank: words.freqRank, answeredKnown: assessmentItems.answeredKnown })
    .from(assessmentItems)
    .innerJoin(words, eq(assessmentItems.wordId, words.id))
    .where(
      and(
        eq(assessmentItems.assessmentId, sittings[0].id),
        eq(assessmentItems.isReal, true),
        isNotNull(assessmentItems.answeredKnown),
        isNotNull(words.freqRank),
      ),
    );
  if (items.length === 0) return null;

  const observations: FitObservation[] = items.map((item: { freqRank: number; answeredKnown: boolean }) => ({
    freqRank: item.freqRank,
    answeredKnown: item.answeredKnown,
  }));

  const [{ maxRank }] = await db
    .select({ maxRank: sql<number>`coalesce(max(${words.freqRank}), 1)` })
    .from(words)
    .where(eq(words.courseId, courseId));

  return fitCurve(observations, sittings[0].falseAlarmRate ?? 0, Number(maxRank));
}

/** Cards already reviewed today, split by whether they were new when reviewed. */
async function todaysCounts(db: AnyDb, userId: string, timeZone: string, day: string) {
  const [row] = await db
    .select({
      reviewed: sql<number>`count(*) filter (where ${reviews.stateBefore} <> 0)`,
      introduced: sql<number>`count(*) filter (where ${reviews.stateBefore} = 0)`,
      cardsDone: sql<number>`count(*)`,
      seconds: sql<number>`coalesce(round(sum(${reviews.durationMs}) / 1000.0), 0)`,
    })
    .from(reviews)
    .where(
      and(
        eq(reviews.userId, userId),
        sql`(${reviews.reviewedAt} at time zone ${timeZone})::date = ${day}::date`,
      ),
    );
  return {
    reviewed: Number(row?.reviewed ?? 0),
    introduced: Number(row?.introduced ?? 0),
    cardsDone: Number(row?.cardsDone ?? 0),
    seconds: Number(row?.seconds ?? 0),
  };
}

/**
 * The learner's median answer time, over correct answers only.
 *
 * Wrong answers are not a pace measurement — they include every card someone
 * stared at and gave up on, which is exactly the tail that would drag the
 * median up and start handing out `Easy` for ordinary answers.
 */
async function medianFor(db: AnyDb, userId: string, exerciseType: string): Promise<number | null> {
  const rows = await db
    .select({ durationMs: reviews.durationMs })
    .from(reviews)
    .innerJoin(cards, eq(reviews.cardId, cards.id))
    .where(
      and(
        eq(reviews.userId, userId),
        eq(cards.exerciseType, exerciseType),
        eq(reviews.wasCorrect, true),
      ),
    )
    .orderBy(desc(reviews.reviewedAt))
    .limit(MEDIAN_WINDOW);
  return rollingMedian(rows.map((row: { durationMs: number }) => row.durationMs));
}

/**
 * Build a session: pick the cards, create any rows they need, hand it over.
 *
 * Returns a session with an empty `cards` array when nothing is due — that is
 * "done for today", a designed screen with the day's numbers on it (PLAN.md
 * §7.2), not an error and not an empty state.
 */
export async function buildSession(
  db: AnyDb,
  userId: string,
  now: Date,
): Promise<StudySession | null> {
  const profile = await profileFor(db, userId);
  const course = await courseFor(db, userId);
  if (!profile || !course) return null;

  const timeZone = safeTimeZone(profile.timezone);
  const day = localDate(now, timeZone);
  const counts = await todaysCounts(db, userId, timeZone, day);

  const reviewsLeft = Math.max(0, profile.dailyReviewLimit - counts.reviewed);
  const newLeft = Math.max(0, profile.dailyNewLimit - counts.introduced);

  // --- due cards ----------------------------------------------------------
  const due =
    reviewsLeft === 0
      ? []
      : await db
          .select({
            cardId: cards.id,
            wordId: cards.wordId,
            exerciseType: cards.exerciseType,
            due: cards.due,
            state: cards.state,
          })
          .from(cards)
          .where(
            and(
              eq(cards.userId, userId),
              eq(cards.suspended, false),
              ne(cards.state, 0),
              lte(cards.due, now),
              isNotNull(cards.wordId),
            ),
          )
          .orderBy(asc(cards.due))
          .limit(reviewsLeft);

  // --- new candidates -----------------------------------------------------
  //
  // Ordering by `freq_rank` and *then* labelling by P(known) is exact, not an
  // approximation: the fitted curve is strictly decreasing in rank, so the top
  // N by rank are the top N by P(known) whatever the learner's curve looks
  // like. The label still has to be computed, because where the boundary falls
  // is entirely learner-specific — and because presenting a half-known word as
  // brand-new material misdescribes the deck back to its owner.
  const fit = await curveFor(db, userId, course.id);
  const candidateRows =
    newLeft === 0
      ? []
      : await db
          .select({
            cardId: cards.id,
            wordId: words.id,
            freqRank: words.freqRank,
            state: cards.state,
          })
          .from(words)
          .leftJoin(
            cards,
            and(
              eq(cards.wordId, words.id),
              eq(cards.userId, userId),
              eq(cards.exerciseType, RECOGNITION),
            ),
          )
          .where(
            and(
              eq(words.courseId, course.id),
              sql`(${cards.id} is null or ${cards.state} = 0)`,
            ),
          )
          // `nulls last`, not the default: a word with no frequency rank is one
          // the corpora never saw, and sorting nulls first would open the deck
          // on exactly those. Postgres puts nulls first for ascending order.
          .orderBy(sql`${words.freqRank} asc nulls last, ${words.id} asc`)
          .limit(newLeft);

  const candidates: NewCandidate[] = candidateRows.map(
    (row: { cardId: string | null; wordId: string; freqRank: number | null }) => ({
      cardId: row.cardId,
      wordId: row.wordId,
      exerciseType: RECOGNITION,
      freqRank: row.freqRank,
      pKnown: fit && row.freqRank ? pKnown(fit, row.freqRank) : 0,
    }),
  );

  const queue = buildQueue(due, candidates, {
    reviewsLeft,
    newLeft,
    targetCards: profile.sessionTargetCards,
  }, now);

  // --- create the rows the new cards need ---------------------------------
  //
  // Up front, not on first answer. The device sends reviews keyed by card id,
  // and a card id that only comes into existence when a review arrives would
  // make the idempotency key — the thing that makes a retried flush safe —
  // depend on whether the flush had already partly succeeded.
  const missing = queue.filter((entry) => entry.cardId === null);
  if (missing.length > 0) {
    await db
      .insert(cards)
      .values(
        missing.map((entry) => ({
          id: cardIdFor(userId, entry.wordId, entry.exerciseType),
          userId,
          courseId: course.id,
          wordId: entry.wordId,
          exerciseType: entry.exerciseType,
          due: now,
        })),
      )
      .onConflictDoNothing();
  }

  const wordIds = queue.map((entry) => entry.wordId);
  const wordRows =
    wordIds.length === 0
      ? []
      : await db
          .select({
            id: words.id,
            lemma: words.lemma,
            pos: words.pos,
            gender: words.gender,
            translations: words.translations,
            primarySense: words.primarySense,
          })
          .from(words)
          .where(inArray(words.id, wordIds));
  const byWordId = new Map(wordRows.map((row: { id: string }) => [row.id, row]));

  const sessionId = randomUUID();
  const payload: SessionCard[] = [];
  for (const entry of queue) {
    const word = byWordId.get(entry.wordId) as
      | { lemma: string; pos: string | null; gender: string | null; translations: unknown; primarySense: string | null }
      | undefined;
    if (!word) continue;
    payload.push({
      cardId: entry.cardId ?? cardIdFor(userId, entry.wordId, entry.exerciseType),
      wordId: entry.wordId,
      kind: entry.kind,
      exerciseType: entry.exerciseType,
      prompt: word.lemma,
      pos: word.pos,
      gender: word.gender,
      translations: Array.isArray(word.translations) ? (word.translations as string[]).map(String) : [],
      primarySense: word.primarySense,
    });
  }

  if (payload.length > 0) {
    await db.insert(studySessions).values({
      id: sessionId,
      userId,
      startedAt: now,
      localDate: day,
    });
  }

  const [next] = await db
    .select({ due: cards.due })
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.suspended, false), ne(cards.state, 0)))
    .orderBy(asc(cards.due))
    .limit(1);

  return {
    sessionId,
    startedAt: now.toISOString(),
    localDate: day,
    cards: payload,
    medianMs: { [RECOGNITION]: await medianFor(db, userId, RECOGNITION) },
    counts: {
      review: payload.filter((card) => card.kind === "review").length,
      boundary: payload.filter((card) => card.kind === "boundary").length,
      fresh: payload.filter((card) => card.kind === "fresh").length,
    },
    today: { cardsDone: counts.cardsDone, seconds: counts.seconds },
    nextDue: next?.due ? new Date(next.due).toISOString() : null,
  };
}

/**
 * Whether this learner still owes the assessment.
 *
 * **Found by running the drill against the live database as a learner who had
 * never been assessed.** The session came back:
 *
 * ```
 * e   = and
 * di  = used to indicate possession
 * il  = the
 * la  = the
 * che = that
 * ```
 *
 * Five function words, two of them with the same translation, one with a
 * grammar note where a meaning should be. That is the whole first impression
 * of the app, and it is not a content bug — those really are the five most
 * frequent Italian words and they really are what an ungated deck opens on.
 *
 * The assessment is what fixes it: every one of those is seeded as known
 * before the drill ever runs, and for an assessed learner the same query
 * returns `regola`, `cliente`, `volto`, `minimo` — ordinary, teachable words.
 * ISSUES.md recorded this as "not fixed, because the assessment runs first"
 * and asked for it to be *verified* rather than assumed. Verified: true for an
 * assessed learner, false for anyone who skips.
 *
 * So the drill refuses to start without a sitting. PLAN.md §6 already says
 * everyone takes it; this is that decision made structural instead of
 * advisory.
 */
export async function needsAssessment(db: AnyDb, userId: string): Promise<boolean> {
  const course = await courseFor(db, userId);
  if (!course) return false;

  const rows = await db
    .select({ id: assessments.id })
    .from(assessments)
    .where(
      and(
        eq(assessments.userId, userId),
        eq(assessments.courseId, course.id),
        // A row is written when the sitting *starts*. Only a finished one
        // counts — the same distinction the dashboard makes, for the same
        // reason: an abandoned sitting seeded nothing.
        isNotNull(assessments.estimatedSize),
      ),
    )
    .limit(1);

  return rows.length === 0;
}

/**
 * The day's numbers, without building a session.
 *
 * For the dashboard and for `/study/done`, which are server-rendered and must
 * not have the side effect of opening a study session.
 */
export async function dayStatus(
  db: AnyDb,
  userId: string,
  now: Date,
): Promise<{ cardsDone: number; seconds: number; dueNow: number; nextDue: Date | null }> {
  const profile = await profileFor(db, userId);
  const timeZone = safeTimeZone(profile?.timezone);
  const day = localDate(now, timeZone);
  const counts = await todaysCounts(db, userId, timeZone, day);

  const [dueRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(cards)
    .where(
      and(
        eq(cards.userId, userId),
        eq(cards.suspended, false),
        ne(cards.state, 0),
        lte(cards.due, now),
      ),
    );

  const [next] = await db
    .select({ due: cards.due })
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.suspended, false), ne(cards.state, 0)))
    .orderBy(asc(cards.due))
    .limit(1);

  return {
    cardsDone: counts.cardsDone,
    seconds: counts.seconds,
    dueNow: Number(dueRow?.count ?? 0),
    nextDue: next?.due ? new Date(next.due) : null,
  };
}

/** Deterministic, and the same shape the assessment writes (`lib/assessment/service.ts`). */
export function cardIdFor(userId: string, wordId: string, exerciseType: string): string {
  return `${userId}:${wordId}:${exerciseType}`;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Apply a batch of reviews. Safe to call twice with the same batch.
 *
 * Idempotency is enforced by *reading the keys first and dropping the
 * duplicates*, not by letting the unique index reject the insert. The
 * difference matters: a rejected insert still leaves the FSRS update applied,
 * so a retried flush would advance every card in the batch a second time and
 * push a week of reviews into next month. The unique index is the backstop,
 * this is the mechanism.
 */
export async function flushReviews(
  db: AnyDb,
  userId: string,
  sessionId: string | null,
  batch: ReviewInput[],
  now: Date,
): Promise<FlushResult | null> {
  const profile = await profileFor(db, userId);
  if (!profile) return null;
  const timeZone = safeTimeZone(profile.timezone);

  let sessionStart = now;
  if (sessionId) {
    const rows = await db
      .select({ id: studySessions.id, userId: studySessions.userId, startedAt: studySessions.startedAt })
      .from(studySessions)
      .where(eq(studySessions.id, sessionId))
      .limit(1);
    if (rows.length === 0 || rows[0].userId !== userId) return null;
    sessionStart = new Date(rows[0].startedAt);
  }

  const keys = batch.map((review) => review.idempotencyKey);
  const seen = new Set<string>(
    (
      await db
        .select({ idempotencyKey: reviews.idempotencyKey })
        .from(reviews)
        .where(and(eq(reviews.userId, userId), inArray(reviews.idempotencyKey, keys)))
    ).map((row: { idempotencyKey: string }) => row.idempotencyKey),
  );

  // A batch may repeat a key inside itself if the device retried locally.
  const fresh: ReviewInput[] = [];
  for (const review of batch) {
    if (seen.has(review.idempotencyKey)) continue;
    seen.add(review.idempotencyKey);
    fresh.push(review);
  }
  const skipped = batch.length - fresh.length;

  if (fresh.length === 0) {
    const day = localDate(now, timeZone);
    const counts = await todaysCounts(db, userId, timeZone, day);
    return { applied: 0, skipped, today: { cardsDone: counts.cardsDone, seconds: counts.seconds } };
  }

  const cardIds = [...new Set(fresh.map((review) => review.cardId))];
  const cardRows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.userId, userId), inArray(cards.id, cardIds)));
  const states = new Map<string, CardState>();
  const courseIds = new Map<string, string>();
  for (const row of cardRows) {
    states.set(row.id, {
      due: new Date(row.due),
      stability: row.stability,
      difficulty: row.difficulty,
      elapsedDays: row.elapsedDays,
      scheduledDays: row.scheduledDays,
      learningSteps: row.learningSteps,
      reps: row.reps,
      lapses: row.lapses,
      state: row.state,
      lastReview: row.lastReview ? new Date(row.lastReview) : null,
    });
    courseIds.set(row.id, row.courseId);
  }

  // Reviews for cards this learner does not own are dropped silently rather
  // than failing the batch: one bad id must not cost the learner the other
  // fifty-nine answers they actually gave.
  const applicable = fresh
    .filter((review) => states.has(review.cardId))
    .map((review) => ({
      ...review,
      reviewedAt: reviewedAtFor(sessionStart, review.offsetMs, now),
    }))
    .sort(
      (a, b) =>
        a.reviewedAt.getTime() - b.reviewedAt.getTime() ||
        (a.idempotencyKey < b.idempotencyKey ? -1 : 1),
    );

  const median = await medianFor(db, userId, RECOGNITION);
  const perDay = new Map<string, { cardsDone: number; ms: number }>();

  await db.transaction(async (tx: AnyDb) => {
    for (const review of applicable) {
      const before = states.get(review.cardId) ?? emptyCardState(review.reviewedAt);
      const rating = gradeFor(review, median);
      const { next, log } = applyReview(before, rating, review.reviewedAt);
      states.set(review.cardId, next);

      await tx.insert(reviews).values({
        id: randomUUID(),
        cardId: review.cardId,
        userId,
        sessionId,
        wasCorrect: review.wasCorrect,
        durationMs: review.durationMs,
        answerGiven: review.answerGiven,
        hintUsed: review.hintUsed,
        rating,
        stateBefore: log.stateBefore,
        stabilityBefore: log.stabilityBefore,
        difficultyBefore: log.difficultyBefore,
        dueBefore: log.dueBefore,
        stabilityAfter: log.stabilityAfter,
        difficultyAfter: log.difficultyAfter,
        scheduledDays: log.scheduledDays,
        elapsedDays: log.elapsedDays,
        reviewedAt: review.reviewedAt,
        source: "drill",
        idempotencyKey: review.idempotencyKey,
      });

      await tx
        .update(cards)
        .set({
          due: next.due,
          stability: next.stability,
          difficulty: next.difficulty,
          elapsedDays: next.elapsedDays,
          scheduledDays: next.scheduledDays,
          learningSteps: next.learningSteps,
          reps: next.reps,
          lapses: next.lapses,
          state: next.state,
          lastReview: next.lastReview,
        })
        .where(eq(cards.id, review.cardId));

      // Keyed on the day the review happened in the learner's zone, not the
      // day the flush arrived. A session that runs past midnight belongs to
      // both days, in the right proportion.
      const day = localDate(review.reviewedAt, timeZone);
      const bucket = perDay.get(day) ?? { cardsDone: 0, ms: 0 };
      bucket.cardsDone += 1;
      bucket.ms += review.durationMs;
      perDay.set(day, bucket);
    }

    for (const [day, bucket] of perDay) {
      const seconds = Math.round(bucket.ms / 1000);
      await tx
        .insert(dailyActivity)
        .values({ userId, localDate: day, cardsDone: bucket.cardsDone, seconds })
        .onConflictDoUpdate({
          target: [dailyActivity.userId, dailyActivity.localDate],
          set: {
            cardsDone: sql`${dailyActivity.cardsDone} + ${bucket.cardsDone}`,
            seconds: sql`${dailyActivity.seconds} + ${seconds}`,
          },
        });
    }

    if (sessionId) {
      const total = applicable.length;
      const seconds = Math.round(
        applicable.reduce((sum, review) => sum + review.durationMs, 0) / 1000,
      );
      await tx
        .update(studySessions)
        .set({
          cardsDone: sql`${studySessions.cardsDone} + ${total}`,
          seconds: sql`${studySessions.seconds} + ${seconds}`,
          endedAt: now,
        })
        .where(eq(studySessions.id, sessionId));
    }
  });

  const day = localDate(now, timeZone);
  const counts = await todaysCounts(db, userId, timeZone, day);
  return {
    applied: applicable.length,
    skipped,
    today: { cardsDone: counts.cardsDone, seconds: counts.seconds },
  };
}

/**
 * Turn a device-measured offset into a server-anchored instant.
 *
 * Clamped at both ends. A negative offset cannot happen from
 * `performance.now()` but can from a hand-written request, and a review dated
 * before its own session would sort ahead of everything and replay wrong. The
 * upper bound stops a buffer flushed the next morning from claiming a
 * timestamp in the future, which would make the card permanently not-due.
 */
export function reviewedAtFor(sessionStart: Date, offsetMs: number, now: Date): Date {
  const offset = Math.min(Math.max(0, Math.round(offsetMs)), MAX_SESSION_MS);
  const at = sessionStart.getTime() + offset;
  return new Date(Math.min(at, now.getTime()));
}
