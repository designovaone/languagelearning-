/**
 * Assessment item sampling (PLAN.md §6, Parts A and B).
 *
 * Pure and seeded. Given the same `(seed, pool)` the same sitting comes out,
 * which is what lets the whole instrument be run against simulated learners
 * without a database — and what makes a failed sitting reproducible instead of
 * a story about something that happened once.
 */

export type WordCandidate = {
  wordId: string;
  lemma: string;
  bandNumber: number;
  freqRank: number | null;
};

export type Item =
  | { kind: "real"; wordId: string; prompt: string; bandNumber: number }
  | { kind: "pseudo"; prompt: string };

/**
 * 50 real words and 20 traps — about four minutes.
 *
 * The count was measured rather than chosen. Against simulated learners the
 * estimate has a standard deviation of roughly 260 words, and that figure is
 * almost flat across the whole range: it is an absolute resolution limit, not a
 * percentage one. More items help slowly (90 real items only moves the overall
 * hit rate from 78% to 89%) because the deck has 7,000 words and each answer is
 * a single bit. 50 sits where the curve flattens.
 */
export const PART_A_REAL = 50;
export const PART_A_PSEUDO = 20;
export const PART_B_ITEMS = 15;

/**
 * mulberry32. Small, fast, and — the reason it is here rather than
 * `Math.random` — seedable, so a sitting is reproducible.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates, using the supplied generator so shuffling stays seeded. */
export function shuffle<T>(input: T[], next: () => number): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Spread `count` picks across bands in proportion to how many candidates each
 * band has, so the sitting covers the whole range rather than clustering in
 * whichever band happens to be largest.
 *
 * Every band with any candidates gets at least one item. A band that is never
 * sampled produces no point on the curve, and `estimateSize` then counts it as
 * zero known — so silently skipping a band would quietly understate a strong
 * learner.
 */
export function allocate(
  bandCounts: Record<number, number>,
  count: number,
): Record<number, number> {
  const bands = Object.keys(bandCounts)
    .map(Number)
    .filter((b) => bandCounts[b] > 0)
    .sort((a, b) => a - b);
  if (bands.length === 0) return {};

  const total = bands.reduce((sum, b) => sum + bandCounts[b], 0);
  const out: Record<number, number> = {};
  let assigned = 0;

  for (const band of bands) {
    const want = Math.max(1, Math.round((count * bandCounts[band]) / total));
    out[band] = Math.min(want, bandCounts[band]);
    assigned += out[band];
  }

  // Rounding and the at-least-one floor rarely land on `count` exactly. Trim
  // from the largest allocations, never below one, and never past what a band
  // actually holds.
  const order = [...bands].sort((a, b) => out[b] - out[a]);
  let index = 0;
  while (assigned > count && order.some((b) => out[b] > 1)) {
    const band = order[index % order.length];
    if (out[band] > 1) {
      out[band] -= 1;
      assigned -= 1;
    }
    index += 1;
  }
  index = 0;
  while (assigned < count && order.some((b) => out[b] < bandCounts[b])) {
    const band = order[index % order.length];
    if (out[band] < bandCounts[band]) {
      out[band] += 1;
      assigned += 1;
    }
    index += 1;
  }
  return out;
}

/**
 * Build a Part A sitting: real words spread across bands, plus the traps,
 * shuffled together so the two kinds are indistinguishable in sequence.
 */
export function buildPartA(
  words: WordCandidate[],
  pseudowords: string[],
  seed: number,
  realCount = PART_A_REAL,
  pseudoCount = PART_A_PSEUDO,
): Item[] {
  const next = rng(seed);

  const byBand = new Map<number, WordCandidate[]>();
  for (const word of words) {
    const list = byBand.get(word.bandNumber) ?? [];
    list.push(word);
    byBand.set(word.bandNumber, list);
  }

  const bandCounts: Record<number, number> = {};
  for (const [band, list] of byBand) bandCounts[band] = list.length;
  const quota = allocate(bandCounts, realCount);

  const picked: Item[] = [];
  for (const band of Object.keys(quota).map(Number).sort((a, b) => a - b)) {
    const pool = shuffle(byBand.get(band) ?? [], next);
    for (const word of pool.slice(0, quota[band])) {
      picked.push({
        kind: "real",
        wordId: word.wordId,
        prompt: word.lemma,
        bandNumber: word.bandNumber,
      });
    }
  }

  for (const form of shuffle(pseudowords, next).slice(0, pseudoCount)) {
    picked.push({ kind: "pseudo", prompt: form });
  }

  return shuffle(picked, next);
}

/**
 * Part B: recall items drawn from around the boundary Part A found.
 *
 * The boundary is the first band whose P(known) drops below 0.5 — the point
 * where self-report stops being confident. Testing there is what converts a
 * claim into a measurement; testing words the learner clearly knows or clearly
 * does not would spend fifteen items learning nothing.
 */
export function boundaryBand(curve: Record<number, number>): number | null {
  const bands = Object.keys(curve).map(Number).sort((a, b) => a - b);
  if (bands.length === 0) return null;
  for (const band of bands) {
    if (curve[band] < 0.5) return band;
  }
  // Every band above the line: the learner is at or past the top of the deck.
  return bands[bands.length - 1];
}

export function buildPartB(
  words: WordCandidate[],
  curve: Record<number, number>,
  alreadyAsked: Set<string>,
  seed: number,
  count = PART_B_ITEMS,
): WordCandidate[] {
  const centre = boundaryBand(curve);
  if (centre === null) return [];
  const next = rng(seed ^ 0x5f3759df);

  // Nearest bands first, so a thin boundary band borrows from its neighbours
  // rather than returning a short list.
  const available = words.filter((w) => !alreadyAsked.has(w.wordId));
  const ranked = [...available].sort((a, b) => {
    const distance = Math.abs(a.bandNumber - centre) - Math.abs(b.bandNumber - centre);
    if (distance !== 0) return distance;
    return next() - 0.5;
  });
  return ranked.slice(0, count);
}
