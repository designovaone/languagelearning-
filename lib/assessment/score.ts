/**
 * Assessment scoring (PLAN.md §6, Parts A and B).
 *
 * The measurement problem this solves: asking "do you know this word?" is the
 * fastest possible instrument and the least trustworthy one. Rather than
 * replacing self-report with something slower, the assessment mixes in invented
 * words and measures how often the learner claims those too. That false-alarm
 * rate is a direct measurement of over-claiming, and it is subtracted.
 *
 * A learner who taps "I know this" on everything scores near zero, not near
 * perfect. That property is tested directly.
 *
 * Everything here is a pure function of the answers. No clock, no database, no
 * randomness — so the whole instrument can be run against simulated learners of
 * known true size, which is how PLAN.md §12 requires it to be validated.
 */

/** One answered item. `isReal` false means it was a generated pseudoword. */
export type AnsweredItem = {
  isReal: boolean;
  /** The band this word belongs to (1 = easiest). Null for pseudowords. */
  bandNumber: number | null;
  /** What the learner said. */
  answeredKnown: boolean;
};

/** One answered recall item from Part B. */
export type RecallItem = {
  bandNumber: number;
  /** Whether the typed answer matched. */
  correct: boolean;
  /** What the learner claimed about this word in Part A, if it was asked. */
  claimedKnown: boolean;
};

export type PartAScore = {
  hitRate: number;
  falseAlarmRate: number;
  /** PLAN.md §6: `hits/real − falseAlarms/pseudo`. Can be negative. */
  correctedScore: number;
};

export type BandCurve = Record<number, number>;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Part A: hit rate, false-alarm rate, and the corrected score.
 *
 * Throws on an empty pseudoword set rather than returning a score. Without
 * traps the false-alarm rate is undefined, and defaulting it to zero would turn
 * pure self-report into something that looks like a corrected measurement —
 * the failure mode would be an inflated number that nothing reports as wrong.
 */
export function scorePartA(items: AnsweredItem[]): PartAScore {
  const real = items.filter((i) => i.isReal);
  const fake = items.filter((i) => !i.isReal);

  if (real.length === 0) throw new Error("scorePartA: no real words");
  if (fake.length === 0) {
    throw new Error(
      "scorePartA: no pseudowords — the false-alarm correction is the " +
        "measurement, so a sitting without traps cannot be scored.",
    );
  }

  const hitRate = real.filter((i) => i.answeredKnown).length / real.length;
  const falseAlarmRate = fake.filter((i) => i.answeredKnown).length / fake.length;
  return { hitRate, falseAlarmRate, correctedScore: hitRate - falseAlarmRate };
}

/**
 * P(known) per band, corrected for guessing.
 *
 * Within a band the raw rate is inflated by whatever the learner claims about
 * words they do not know, so it is rescaled against the false-alarm rate:
 *
 *     p = (raw − fa) / (1 − fa)
 *
 * That is the standard correction for guessing, and it reduces to the raw rate
 * when nobody over-claims. At `fa = 1` — a learner who claimed every single
 * trap — the answers carry no information at all and every band scores 0.
 */
export function bandCurve(items: AnsweredItem[], falseAlarmRate: number): BandCurve {
  const totals = new Map<number, { known: number; count: number }>();
  for (const item of items) {
    if (!item.isReal || item.bandNumber === null) continue;
    const entry = totals.get(item.bandNumber) ?? { known: 0, count: 0 };
    entry.count += 1;
    if (item.answeredKnown) entry.known += 1;
    totals.set(item.bandNumber, entry);
  }

  const curve: BandCurve = {};
  for (const [band, { known, count }] of totals) {
    const raw = known / count;
    curve[band] =
      falseAlarmRate >= 1 ? 0 : clamp01((raw - falseAlarmRate) / (1 - falseAlarmRate));
  }
  return curve;
}

/**
 * Part B: rescale the self-reported curve by how much of the claim survived
 * being measured.
 *
 * Of the boundary words the learner said they knew, some fraction actually came
 * back correct. That fraction is the calibration factor. Someone who claims
 * accurately gets ~1.0 and their curve is untouched; someone who over-claims
 * gets a factor below 1 and the whole curve comes down.
 *
 * Returns `null` when nothing was both claimed and tested, which is the honest
 * answer — there is nothing to calibrate against, and inventing a factor of 1
 * would silently assert the learner was accurate.
 */
export function calibration(recall: RecallItem[]): number | null {
  const claimed = recall.filter((r) => r.claimedKnown);
  if (claimed.length === 0) return null;
  const correct = claimed.filter((r) => r.correct).length;
  return correct / claimed.length;
}

/** Apply a calibration factor to every band. */
export function calibrate(curve: BandCurve, factor: number | null): BandCurve {
  if (factor === null) return { ...curve };
  const out: BandCurve = {};
  for (const [band, p] of Object.entries(curve)) {
    out[Number(band)] = clamp01(p * factor);
  }
  return out;
}

/**
 * Estimated vocabulary size: the curve weighted by how many words each band
 * actually holds.
 *
 * A band that was never sampled contributes nothing rather than being
 * interpolated. PLAN.md §6 is explicit that a word never tested is never
 * counted as known — an over-estimate here would seed cards as `Review` and
 * make real vocabulary invisible for weeks.
 */
export function estimateSize(curve: BandCurve, bandSizes: Record<number, number>): number {
  let total = 0;
  for (const [band, p] of Object.entries(curve)) {
    total += p * (bandSizes[Number(band)] ?? 0);
  }
  return Math.round(total);
}
