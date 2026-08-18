/**
 * The one place `ts-fsrs` is called. Nothing else in the codebase constructs a
 * scheduler, and **the client never computes FSRS state at all** (PLAN.md §2):
 * the device reports what happened, the server decides what it means.
 *
 * That split is what makes the review log authoritative. A client that
 * computed intervals would make every bug in a stale service worker a
 * permanent, unfixable corruption of someone's schedule.
 */

import { fsrs, generatorParameters, type Grade } from "ts-fsrs";

import { fromFsrsCard, toFsrsCard, type CardState } from "./serde";

/**
 * **Fuzz is off, deliberately and explicitly.**
 *
 * It is already off by default in ts-fsrs 5.4.1, so this line changes nothing
 * today — it is here so a future default cannot change it silently. Fuzz
 * randomises each interval by a few percent to stop reviews clumping. The
 * replay invariant in PLAN.md §7.4 says replaying a review log must reproduce
 * the same card states; with fuzz on, it reproduces *nearly* the same states,
 * and an invariant that holds approximately is not an invariant.
 *
 * The clumping fuzz exists to prevent is handled where it actually occurs
 * here: the assessment spreads its seeded cards across the interval by
 * frequency rank (`lib/assessment/seed.ts`), which is the only moment this
 * project creates thousands of cards at once.
 *
 * ### Short-term learning steps are off — decided at build time
 *
 * With them on (the ts-fsrs default of 1m/10m), a brand-new card answered
 * `Good` becomes due **ten minutes later** in state `Learning`. A session here
 * is fifteen cards and takes about two minutes, so those ten minutes land
 * after the phone is back in a pocket — and the app shows *"done for today"*
 * while fifteen cards are due before the kettle boils.
 *
 * That is not a cosmetic mismatch. PLAN.md §7.2 calls "done for today" the
 * screen a commercial app structurally cannot offer, and the whole argument of
 * this project rests on it being **true**. A screen that says stop while the
 * queue refills in ten minutes is the grind wearing the anti-grind's clothes.
 *
 * With them off, the same card is due in **three days** in state `Review`, and
 * a session is self-contained. Measured, both ways:
 *
 * | New card, answered | steps on | steps off |
 * |---|---|---|
 * | `Again` | 1 min | 1.0 d |
 * | `Hard`  | 6 min | 2.0 d |
 * | `Good`  | 10 min | 3.0 d |
 * | `Easy`  | 8.0 d | 8.0 d |
 *
 * **The stability values are identical either way** — 0.21 / 1.29 / 2.31 /
 * 8.30. The memory model does not change; only whether FSRS insists on a
 * second look before it will commit to an interval.
 *
 * What is given up is the immediate re-exposure of a brand-new word. That is
 * bought back where it belongs, in the UI rather than in the scheduler: the
 * drill re-queues a card answered wrong within the same session, so the
 * learner still sees the correction while the word is in mind. One line to
 * reverse if two weeks of real use argues the other way.
 */
export const PARAMETERS = generatorParameters({
  enable_fuzz: false,
  enable_short_term: false,
});

const scheduler = fsrs(PARAMETERS);

export type Applied = {
  /** The card after the review. */
  next: CardState;
  /** ts-fsrs's own before/after record, stored on the review row. */
  log: {
    stateBefore: number;
    stabilityBefore: number;
    difficultyBefore: number;
    dueBefore: Date;
    stabilityAfter: number;
    difficultyAfter: number;
    scheduledDays: number;
    elapsedDays: number;
  };
};

/**
 * Apply one grade to one card at one instant.
 *
 * Pure: same inputs, same outputs, no clock, no database. That is what lets
 * `replay.ts` re-derive an entire history and what lets the flush endpoint be
 * safely retried.
 */
export function applyReview(card: CardState, rating: Grade, reviewedAt: Date): Applied {
  const before = toFsrsCard(card);
  const { card: after, log } = scheduler.next(before, reviewedAt, rating);

  return {
    next: fromFsrsCard(after),
    log: {
      // The "before" values are read off the input card, not off ts-fsrs's
      // ReviewLog. The log's `due` is `last_review || due` — the field its own
      // rollback needs, which is not the same thing as the due date this card
      // carried. Reading them from the input is correct by construction and
      // stays correct if the library's log shape changes.
      stateBefore: card.state,
      stabilityBefore: card.stability,
      difficultyBefore: card.difficulty,
      dueBefore: card.due,
      stabilityAfter: after.stability,
      difficultyAfter: after.difficulty,
      scheduledDays: after.scheduled_days,
      // Days since the previous review. Genuinely raw signal, unlike the
      // deprecated `elapsed_days` column on `cards`.
      elapsedDays: log.elapsed_days,
    },
  };
}
