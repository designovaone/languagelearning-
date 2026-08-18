import { randomUUID } from "node:crypto";

import { and, asc, eq, isNotNull } from "drizzle-orm";

import {
  assessmentItems,
  assessments,
  bands,
  cards,
  courses,
  enrollments,
  words,
} from "@/lib/db/schema";

import { estimateSizeFromFit, fitCurve, pKnown, type FitObservation } from "./fit";
import { buildPartA, type Item, type WordCandidate } from "./items";
import { bandCurve, scorePartA, type AnsweredItem } from "./score";
import { planSeeding, summarise } from "./seed";

/**
 * The assessment, joined up (PLAN.md §6).
 *
 * Everything decision-shaped lives in the pure modules beside this one —
 * `items`, `score`, `fit`, `seed` — so the instrument can be validated against
 * simulated learners without a database. This file does the parts that need
 * one: read the deck, persist the sitting, write the cards.
 *
 * `now` is a parameter throughout, per the clock rule in CLAUDE.md.
 */

// The Drizzle database type varies by driver.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type StartedAssessment = {
  assessmentId: string;
  courseSlug: string;
  items: Array<{ index: number; prompt: string }>;
};

export type SubmittedAnswer = {
  index: number;
  answeredKnown: boolean;
  durationMs?: number;
};

export type AssessmentResult = {
  estimatedSize: number;
  /**
   * Half-width of the reported range, in words. Reported because the
   * instrument's resolution is ~260 words (1 sd) at every level — showing a
   * bare number would claim a precision the measurement does not have.
   */
  margin: number;
  hitRate: number;
  falseAlarmRate: number;
  correctedScore: number;
  seeded: { known: number; boundary: number; new: number };
};

/** ~2 standard deviations, measured against simulated learners. */
export const REPORTED_MARGIN = 550;

/**
 * The learner's course, or null if they are not enrolled in one.
 *
 * Exported because the route needs the course *slug* to choose a pseudoword
 * pool before it can start a sitting. The first version called
 * `startAssessment` with an empty pool just to read the slug, then called it
 * again for real — which wrote a second `assessments` row on every single
 * start. Those orphans then counted as sittings: the dashboard decides what to
 * offer by asking whether an assessment exists, so merely opening the page and
 * walking away would have hidden the assessment link for good.
 */
export async function courseFor(db: AnyDb, userId: string) {
  const rows = await db
    .select({ id: courses.id, slug: courses.slug })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(eq(enrollments.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

async function deckFor(db: AnyDb, courseId: string): Promise<WordCandidate[]> {
  const rows = await db
    .select({
      wordId: words.id,
      lemma: words.lemma,
      bandNumber: bands.number,
      freqRank: words.freqRank,
    })
    .from(words)
    .innerJoin(bands, eq(words.bandId, bands.id))
    .where(and(eq(words.courseId, courseId), isNotNull(words.freqRank)))
    .orderBy(asc(words.freqRank));
  return rows as WordCandidate[];
}

/**
 * Start a sitting: choose the items, store them unanswered, return the prompts.
 *
 * The items are persisted *before* the learner sees them, and the answer step
 * reads them back by index. The client is therefore never told which prompts
 * are real — sending that down and trusting it back would let anyone score
 * perfectly, and more importantly would make the false-alarm rate, the one
 * measurement that makes the whole thing trustworthy, client-controlled.
 */
export async function startAssessment(
  db: AnyDb,
  userId: string,
  pseudowords: string[],
  now: Date,
  seed = Math.floor(Math.random() * 2 ** 31),
): Promise<StartedAssessment | null> {
  const course = await courseFor(db, userId);
  if (!course) return null;

  const deck = await deckFor(db, course.id);
  if (deck.length === 0) return null;

  const chosen: Item[] = buildPartA(deck, pseudowords, seed);
  const assessmentId = randomUUID();

  await db.insert(assessments).values({
    id: assessmentId,
    userId,
    courseId: course.id,
    takenAt: now,
  });

  await db.insert(assessmentItems).values(
    chosen.map((item, index) => ({
      // Index is encoded in the id, so an answer can be matched to its item
      // without the client ever being told which is which.
      id: `${assessmentId}:${index}`,
      assessmentId,
      wordId: item.kind === "real" ? item.wordId : null,
      pseudoword: item.kind === "pseudo" ? item.prompt : null,
      isReal: item.kind === "real",
    })),
  );

  return {
    assessmentId,
    courseSlug: course.slug,
    items: chosen.map((item, index) => ({ index, prompt: item.prompt })),
  };
}

/**
 * Finish a sitting: record the answers, score it, seed the deck.
 *
 * Runs in one transaction. A scored assessment with no cards behind it would
 * show the learner a number and leave them with an unseeded deck — and nothing
 * would report the difference.
 */
export async function submitAssessment(
  db: AnyDb,
  userId: string,
  assessmentId: string,
  answers: SubmittedAnswer[],
  now: Date,
): Promise<AssessmentResult | null> {
  const sitting = await db
    .select({ id: assessments.id, courseId: assessments.courseId, userId: assessments.userId })
    .from(assessments)
    .where(eq(assessments.id, assessmentId))
    .limit(1);
  if (sitting.length === 0 || sitting[0].userId !== userId) return null;
  const courseId = sitting[0].courseId as string;

  const stored = await db
    .select({
      id: assessmentItems.id,
      wordId: assessmentItems.wordId,
      isReal: assessmentItems.isReal,
    })
    .from(assessmentItems)
    .where(eq(assessmentItems.assessmentId, assessmentId));

  const byIndex = new Map<number, (typeof stored)[number]>();
  for (const row of stored) {
    byIndex.set(Number(String(row.id).split(":").pop()), row);
  }

  // Word metadata for the items that were real, so answers can be placed on
  // the frequency curve.
  const deck = await deckFor(db, courseId);
  const byWordId = new Map(deck.map((w) => [w.wordId, w]));

  const answered: AnsweredItem[] = [];
  const observations: FitObservation[] = [];

  for (const answer of answers) {
    const item = byIndex.get(answer.index);
    if (!item) continue;
    const word = item.wordId ? byWordId.get(item.wordId) : undefined;

    answered.push({
      isReal: item.isReal,
      bandNumber: word?.bandNumber ?? null,
      answeredKnown: answer.answeredKnown,
    });
    if (item.isReal && word?.freqRank) {
      observations.push({ freqRank: word.freqRank, answeredKnown: answer.answeredKnown });
    }

    await db
      .update(assessmentItems)
      .set({ answeredKnown: answer.answeredKnown, durationMs: answer.durationMs ?? null })
      .where(eq(assessmentItems.id, item.id));
  }

  const score = scorePartA(answered);
  const curve = bandCurve(answered, score.falseAlarmRate);
  const ranks = deck.map((w) => w.freqRank as number);
  // The *largest rank*, not the number of words: `freqRank` is the blended
  // global corpus rank from stage 1b, so a 7,083-word deck carries ranks up to
  // ~276,000. Worth a measured RMSE of 268 → 219 words for the strongest
  // learners and nothing detectable below ~5,000 (see `fit.ts`).
  const maxRank = ranks.reduce((max, rank) => (rank > max ? rank : max), 1);
  const fit = fitCurve(observations, score.falseAlarmRate, maxRank);
  const estimatedSize = estimateSizeFromFit(fit, ranks);

  // Per-word probability from the fitted curve, not the band average. The
  // band curve is still stored on the sitting because it is what a human can
  // read; it is far too coarse to seed from.
  const plans = planSeeding(
    deck.map((w) => ({
      wordId: w.wordId,
      bandNumber: w.bandNumber,
      freqRank: w.freqRank,
      pKnown: w.freqRank
        ? pKnown(fit, w.freqRank)
        : (curve[w.bandNumber] ?? 0),
    })),
    now,
  );
  const seeded = summarise(plans);

  await db.transaction(async (tx: AnyDb) => {
    await tx
      .update(assessments)
      .set({
        estimatedSize,
        hitRate: score.hitRate,
        falseAlarmRate: score.falseAlarmRate,
        correctedScore: score.correctedScore,
        bandCurve: curve,
      })
      .where(eq(assessments.id, assessmentId));

    // Only the `known` plans become rows. A `New` card carries no information
    // that the absence of a card does not already carry, and writing 7,000
    // empty rows per learner would make the queue read slower for nothing.
    const rows = plans
      .filter((plan) => plan.reason === "known")
      .map((plan) => ({
        id: `${userId}:${plan.wordId}:recognition`,
        userId,
        courseId,
        wordId: plan.wordId,
        exerciseType: "recognition",
        due: plan.due,
        stability: plan.stability,
        difficulty: 5,
        state: plan.state,
        reps: 0,
        lapses: 0,
      }));

    for (let i = 0; i < rows.length; i += 500) {
      await tx
        .insert(cards)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing();
    }
  });

  return {
    estimatedSize,
    margin: REPORTED_MARGIN,
    hitRate: score.hitRate,
    falseAlarmRate: score.falseAlarmRate,
    correctedScore: score.correctedScore,
    seeded,
  };
}
