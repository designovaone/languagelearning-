/**
 * The FSRS grade is derived, never asked for (PLAN.md §7.3).
 *
 * A learner is never shown four buttons. Correctness comes from the answer and
 * speed comes from the clock, and those two produce the rating:
 *
 * | Signal                                   | Grade   |
 * |------------------------------------------|---------|
 * | Wrong                                    | `Again` |
 * | Right, fast (below 40% of their median)   | `Easy`  |
 * | Right, normal                            | `Good`  |
 * | Right but slow, or a hint was used        | `Hard`  |
 *
 * **This function is pure, and that is the whole insurance policy.** Every
 * review stores `was_correct`, `duration_ms`, `answer_given` and `hint_used`,
 * so if this mapping turns out to be wrong the entire history can be replayed
 * through a new one (`replay.ts`). Four stored columns turn an irreversible
 * modelling choice into a re-run — but only while the mapping stays a function
 * of stored signal alone. Nothing here may read the database or the clock.
 */

import { Rating, type Grade } from "ts-fsrs";

/** Below this fraction of the learner's median, an answer counts as fast. */
export const FAST_FRACTION = 0.4;
/** Above this multiple of the median, an answer counts as slow. */
export const SLOW_MULTIPLE = 2;
/** Durations beyond this multiple are treated as this multiple. */
export const OUTLIER_CLAMP = 3;
/**
 * Reviews needed before a median means anything.
 *
 * Under this, every correct answer is `Good`. A median of two samples would
 * hand out `Easy` and `Hard` on the strength of one earlier card, and those
 * ratings move stability a long way — the wrong call at review three is still
 * visible at review thirty.
 */
export const MIN_SAMPLES_FOR_MEDIAN = 10;

export type RawSignal = {
  wasCorrect: boolean;
  durationMs: number;
  hintUsed: boolean;
};

/**
 * The learner's own pace, per exercise type.
 *
 * Outliers are clamped *before* the median is taken, not after: the learner
 * who answers three cards and then takes a phone call contributes one
 * eleven-minute duration, and an unclamped median of a short session moves
 * with it. Clamping at the median stage is where it changes an answer —
 * clamping inside `gradeFor` would be decorative, because anything past 3×
 * is past 2× and already slow.
 */
export function rollingMedian(durationsMs: number[]): number | null {
  if (durationsMs.length < MIN_SAMPLES_FOR_MEDIAN) return null;

  const sorted = [...durationsMs].sort((a, b) => a - b);
  const raw = median(sorted);
  const clamped = sorted.map((ms) => Math.min(ms, raw * OUTLIER_CLAMP));
  clamped.sort((a, b) => a - b);
  return median(clamped);
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * `medianMs` is `null` until the learner has a baseline — a brand-new account,
 * or the first cards of a new exercise type. That path is not an edge case: it
 * is every learner's first session, so it is tested directly.
 *
 * **Latency alone never produces `Again`.** Slowness means the recall was
 * effortful, not absent; a card the learner got right must never be treated as
 * forgotten, or a distraction mid-session costs them progress they earned.
 */
export function gradeFor(signal: RawSignal, medianMs: number | null): Grade {
  if (!signal.wasCorrect) return Rating.Again;
  if (signal.hintUsed) return Rating.Hard;
  if (medianMs === null || medianMs <= 0) return Rating.Good;

  if (signal.durationMs < medianMs * FAST_FRACTION) return Rating.Easy;
  if (signal.durationMs > medianMs * SLOW_MULTIPLE) return Rating.Hard;
  return Rating.Good;
}
