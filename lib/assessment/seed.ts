/**
 * Part C: turn the probability-of-known curve into starting card states
 * (PLAN.md §6).
 *
 * ### The asymmetry that decides every threshold here
 *
 * PLAN.md §6: *"Never mark a word known that was never tested. Seed low."*
 *
 * The two errors are not equally bad, and it is worth being precise about why.
 * Seed a word as `Review` that the learner does not actually know, and it
 * disappears for up to three weeks — invisible, unlearned, and nothing reports
 * it. Seed a word as `New` that they do know, and it appears once, they get it
 * right, and FSRS pushes it out to a long interval within two or three
 * reviews. The system self-corrects in one direction and not the other.
 *
 * So the bar for `Review` is high, the stability granted is modest, and
 * everything uncertain starts `New`.
 */

import { State } from "ts-fsrs";

export type SeedTarget = {
  wordId: string;
  bandNumber: number;
  /** Blended frequency rank (stage 1b). Decides where in the window it lands. */
  freqRank: number | null;
  /**
   * P(this learner knows *this word*), from the fitted frequency curve.
   *
   * Per word, not per band. Seeding originally read the band average, and on
   * the first honest sitting that produced an estimate of 4,520 known words
   * and **zero seeded cards**: Italian has three bands, so a learner has to
   * clear 80% of a 3,000-word band before a single card is seeded, which only
   * a near-fluent learner ever does. The estimate and the seeding disagreed
   * completely, and nothing reported it — the number looked right.
   */
  pKnown: number;
};

export type SeedPlan = {
  wordId: string;
  state: State;
  /** Days. Zero for a `New` card. */
  stability: number;
  due: Date;
  /** Why this card got this state — stored for the replay in §7.3. */
  reason: "known" | "boundary" | "new";
};

/** At or above this P(known), a word is seeded as already learned. */
export const KNOWN_THRESHOLD = 0.8;
/** Between this and KNOWN_THRESHOLD: `New`, but flagged for the front of the queue. */
export const BOUNDARY_THRESHOLD = 0.5;

/** PLAN.md §6: "stability scaled to confidence (~3–21 days)". */
export const MIN_STABILITY = 3;
export const MAX_STABILITY = 21;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Confidence above the threshold, mapped onto the stability range.
 *
 * `p = 0.8` earns the floor of 3 days, `p = 1.0` the ceiling of 21. Note that
 * even total confidence buys only three weeks: the curve is a band-level
 * estimate applied to an individual word that may never have been shown, so
 * the granted interval is deliberately shorter than the certainty implies.
 */
export function stabilityFor(p: number): number {
  const span = (p - KNOWN_THRESHOLD) / (1 - KNOWN_THRESHOLD);
  const clamped = Math.min(1, Math.max(0, span));
  return MIN_STABILITY + clamped * (MAX_STABILITY - MIN_STABILITY);
}

/**
 * Where in the interval one word lands, as a number of days.
 *
 * **Every seeded card must not fall due on the same date.** P(known) is a
 * band-level number, so every word in a band shares a stability, and the
 * obvious `now + stability` gave a real learner 4,906 reviews due on a single
 * day three weeks out. The unit tests all passed: they asserted `due > now`,
 * which was true of every one of them.
 *
 * So the window is spread, and spread by frequency rank rather than at random:
 * a rarer word is the one the band-level estimate is least likely to be right
 * about, so it comes back sooner and gets corrected sooner. The most common
 * words — the ones the learner almost certainly does know — wait the longest.
 *
 * Deterministic, so re-running the same assessment produces the same schedule.
 */
function dueDays(
  target: SeedTarget,
  stability: number,
  spread: Map<string, number>,
): number {
  const position = spread.get(target.wordId) ?? 1;
  // Never same-day: the floor is one day, the ceiling the full stability.
  return 1 + position * (stability - 1);
}

/**
 * One plan entry per word, from that word's own P(known).
 *
 * A word with no evidence behind it arrives with `pKnown` at 0 and is seeded
 * `New`. No evidence must never read as "known" — the same asymmetry as above.
 */
export function planSeeding(targets: SeedTarget[], now: Date): SeedPlan[] {
  // Rank the words that will be seeded, rarest first, and map each to its
  // fractional position in the interval.
  const seeded = targets
    .filter((t) => t.pKnown >= KNOWN_THRESHOLD)
    .sort((a, b) => (b.freqRank ?? 0) - (a.freqRank ?? 0));
  const spread = new Map<string, number>();
  seeded.forEach((target, index) => {
    spread.set(target.wordId, seeded.length <= 1 ? 1 : index / (seeded.length - 1));
  });

  return targets.map((target) => {
    const p = target.pKnown;

    if (p >= KNOWN_THRESHOLD) {
      const stability = stabilityFor(p);
      return {
        wordId: target.wordId,
        state: State.Review,
        stability,
        due: new Date(now.getTime() + Math.round(dueDays(target, stability, spread) * DAY_MS)),
        reason: "known",
      };
    }

    return {
      wordId: target.wordId,
      state: State.New,
      stability: 0,
      due: now,
      reason: p >= BOUNDARY_THRESHOLD ? "boundary" : "new",
    };
  });
}

/**
 * How many cards each outcome produced. For the summary screen, and for the
 * check that a learner who over-claimed did not walk away with a deck seeded
 * as entirely known.
 */
export function summarise(plans: SeedPlan[]): Record<SeedPlan["reason"], number> {
  const counts = { known: 0, boundary: 0, new: 0 };
  for (const plan of plans) counts[plan.reason] += 1;
  return counts;
}
