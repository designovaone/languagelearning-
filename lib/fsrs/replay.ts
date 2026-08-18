/**
 * Replay a review log into final card states (PLAN.md §7.3, §7.4).
 *
 * Two jobs, and the second is the reason this file exists at all.
 *
 * 1. **The batching invariant.** The client flushes reviews in batches whose
 *    boundaries depend on network luck, tab visibility and when the learner
 *    put the phone down. Replaying the same log must produce the same final
 *    states however it was chopped up, or the schedule is a function of the
 *    connection quality. Tested directly.
 *
 * 2. **The escape hatch.** The grade mapping in `grade.ts` is a judgement
 *    call — 40% of a rolling median is a guess that will look wrong in three
 *    months. Because every review stores its raw signal, a new mapping can be
 *    run over the whole history and every card recomputed. That is only true
 *    while replay is possible, so it is a tested property rather than an
 *    intention.
 *
 * Ordering is by `reviewedAt`, then by `idempotencyKey` to break ties. Two
 * reviews of one card inside the same millisecond cannot happen on a device a
 * human is holding, but a deterministic tiebreak costs nothing and removes a
 * source of "it passed on my machine".
 */

import { type Grade } from "ts-fsrs";

import { gradeFor, type RawSignal } from "./grade";
import { applyReview } from "./scheduler";
import { emptyCardState, type CardState } from "./serde";

export type LoggedReview = {
  cardId: string;
  reviewedAt: Date;
  idempotencyKey: string;
} & RawSignal;

export type ReplayOptions = {
  /**
   * The mapping to replay through. Defaults to the current one; pass a
   * different function to re-derive history under a new mapping.
   */
  grader?: (signal: RawSignal) => Grade;
};

/**
 * Fold a review log over starting card states.
 *
 * `starting` holds the state each card was in *before* the first review in the
 * log. A card missing from it is assumed to have started empty — which is what
 * a word being met for the first time looks like.
 */
export function replay(
  log: LoggedReview[],
  starting: Map<string, CardState>,
  options: ReplayOptions = {},
): Map<string, CardState> {
  const grader = options.grader ?? ((signal: RawSignal) => gradeFor(signal, null));

  const ordered = [...log].sort((a, b) => {
    const byTime = a.reviewedAt.getTime() - b.reviewedAt.getTime();
    if (byTime !== 0) return byTime;
    return a.idempotencyKey < b.idempotencyKey ? -1 : a.idempotencyKey > b.idempotencyKey ? 1 : 0;
  });

  const states = new Map(starting);

  for (const entry of ordered) {
    const current = states.get(entry.cardId) ?? emptyCardState(entry.reviewedAt);
    const { next } = applyReview(current, grader(entry), entry.reviewedAt);
    states.set(entry.cardId, next);
  }

  return states;
}
