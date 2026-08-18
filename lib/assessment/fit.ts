/**
 * Estimating vocabulary size from the answers (PLAN.md §6, Part C input).
 *
 * ### Why this is not just the band curve averaged
 *
 * The obvious estimator — take the share of known words in each band, multiply
 * by the band's size, add up — is *unbiased* and far too noisy to use. Measured
 * against simulated learners of known size it lands within ±17 words on
 * average, but with a standard deviation around 300. Italian has three bands,
 * so forty real items become three proportions of roughly thirteen items each,
 * and thirteen coin flips do not pin a proportion down. Band 2 alone
 * contributes ±390 words of noise.
 *
 * That noise is not a tuning problem. It is the resolution limit of treating a
 * band as the unit: every word inside a band is scored identically, so the
 * 3,000 words of Italian `alto uso` get one number derived from thirteen
 * answers.
 *
 * ### What this does instead
 *
 * Each answer knows its word's exact frequency rank, and vocabulary knowledge
 * is smooth in frequency: common words are known, rare ones are not, with a
 * transition in between. So fit that transition directly —
 *
 *     P(known | rank) = 1 / (1 + exp((ln rank − mu) / s))
 *
 * `mu` is the log-rank at which the learner is 50% likely to know a word, `s`
 * how sharp the boundary is. Two parameters against forty observations, rather
 * than three proportions against thirteen observations each, and every item now
 * carries information about where the boundary sits rather than only about its
 * own band.
 *
 * The answers are not observed directly: a learner claims a word if they know
 * it *and* do not slip, or claim it anyway. So the likelihood is written over
 * what is actually observable —
 *
 *     P(claim | rank) = (1 − lapse) · P(known) + fa · (1 − P(known))
 *
 * with `fa` measured from the traps. Without the `lapse` term the fit reads
 * every slip as ignorance, which showed up as a growing negative bias for
 * strong learners: −546 words at a true size of 6,500.
 */

export type FitObservation = {
  freqRank: number;
  answeredKnown: boolean;
};

export type CurveFit = {
  /** Log-rank of the 50% point. */
  mu: number;
  /** Width of the transition, in log-rank units. */
  s: number;
};

/**
 * Rate at which a learner fails to claim a word they do know. Fixed rather than
 * fitted: a third free parameter is not identifiable from forty binary answers,
 * and a wrong-but-stable assumption beats an unstable estimate. 6% is the
 * middle of what the simulations sweep.
 */
export const LAPSE = 0.06;

const MIN_S = 0.15;
const MAX_S = 3.0;

export function pKnown(fit: CurveFit, freqRank: number): number {
  const x = (Math.log(Math.max(1, freqRank)) - fit.mu) / fit.s;
  return 1 / (1 + Math.exp(x));
}

/** What we can actually observe: a claim, not knowledge. */
function pClaim(fit: CurveFit, freqRank: number, falseAlarmRate: number): number {
  const known = pKnown(fit, freqRank);
  return (1 - LAPSE) * known + falseAlarmRate * (1 - known);
}

function logLikelihood(
  fit: CurveFit,
  observations: FitObservation[],
  falseAlarmRate: number,
): number {
  let total = 0;
  for (const observation of observations) {
    const p = Math.min(0.999, Math.max(0.001, pClaim(fit, observation.freqRank, falseAlarmRate)));
    total += observation.answeredKnown ? Math.log(p) : Math.log(1 - p);
  }
  return total;
}

/**
 * Maximum likelihood by coarse grid then local refinement.
 *
 * A grid rather than gradient descent because the surface is only
 * two-dimensional and bounded, so this is both fast enough and immune to the
 * local optima a naive descent hits when every answer happens to agree.
 *
 * `maxRank` is the **largest frequency rank in the deck**, not the number of
 * words in it. Those differ by more than an order of magnitude: stage 1b writes
 * a global corpus rank, so a 7,083-word Italian deck spans ranks 2 to ~276,000.
 *
 * Passing the count instead is a mild error rather than a fatal one, and it is
 * worth being precise about why, because the obvious reasoning is wrong. The
 * grid would stop at ln(7083) = 8.9 while a near-fluent learner's boundary sits
 * near ln(276000) = 12.5 — but the refinement below does not clamp `mu`, so it
 * simply walks out of the grid and finds the peak anyway. Measured over 200
 * sittings on a sparse deck the difference is small and confined to the top of
 * the range: RMSE 268 → 219 words at a true size of 6,500, and nothing outside
 * the noise below about 5,000. Correct, but not load-bearing.
 */
export function fitCurve(
  observations: FitObservation[],
  falseAlarmRate: number,
  maxRank: number,
): CurveFit {
  const hi = Math.log(Math.max(2, maxRank));
  let best: CurveFit = { mu: hi / 2, s: 0.8 };
  let bestScore = -Infinity;

  for (let i = 0; i <= 40; i++) {
    const mu = (hi * 1.2 * i) / 40 - hi * 0.1;
    for (let j = 0; j <= 20; j++) {
      const s = MIN_S + ((MAX_S - MIN_S) * j) / 20;
      const score = logLikelihood({ mu, s }, observations, falseAlarmRate);
      if (score > bestScore) {
        bestScore = score;
        best = { mu, s };
      }
    }
  }

  let step = hi / 40;
  for (let round = 0; round < 30; round++) {
    let improved = false;
    for (const [dmu, ds] of [
      [step, 0], [-step, 0], [0, step / 4], [0, -step / 4],
    ] as const) {
      const candidate = {
        mu: best.mu + dmu,
        s: Math.min(MAX_S, Math.max(MIN_S, best.s + ds)),
      };
      const score = logLikelihood(candidate, observations, falseAlarmRate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }

  return best;
}

/**
 * Integrate the fitted curve over the deck: the expected number of known words.
 *
 * Summed over actual ranks rather than solved in closed form, so a deck whose
 * ranks are sparse or unevenly spaced is handled without special-casing.
 */
export function estimateSizeFromFit(fit: CurveFit, ranks: number[]): number {
  let total = 0;
  for (const rank of ranks) total += pKnown(fit, rank);
  return Math.round(total);
}
