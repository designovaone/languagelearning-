/**
 * Queue construction (PLAN.md §7.1). Pure: rows in, order out.
 *
 * ### The thing this file exists to get right
 *
 * After the assessment, a real learner's deck looked like this:
 *
 * | | |
 * |---|---|
 * | seeded `known` — real `Review` cards | 1,219 |
 * | **`boundary`** — P(known) between 0.5 and 0.8 | **4,381** |
 * | genuinely new | 1,483 |
 *
 * Only the `known` plans became card rows (`lib/assessment/seed.ts`), so the
 * middle 4,381 and the last 1,483 are indistinguishable by card state: both
 * are simply words with no row. The distinction lives in the fitted curve.
 *
 * Ordering everything by frequency rank happens to put the boundary words
 * first, because they are the more common ones. That is an accident of the
 * data, not a property of the code — a learner whose curve sits somewhere else
 * would get a different answer from the same ordering. So P(known) is computed
 * per candidate and used explicitly, and every card carries the label it was
 * ordered by. The UI needs it too: showing 4,381 half-known words as brand-new
 * material misdescribes the learner's own deck back to them.
 */

/** What the learner is being asked to do. Only `recognition` exists at M4. */
export type ExerciseType = "recognition" | "production" | "listening" | "sentence" | "grammar";

export type DueCard = {
  cardId: string;
  wordId: string;
  exerciseType: ExerciseType;
  due: Date;
  state: number;
};

export type NewCandidate = {
  /** Null when no row exists yet — most of them. */
  cardId: string | null;
  wordId: string;
  exerciseType: ExerciseType;
  freqRank: number | null;
  /** From the fitted curve of the learner's most recent sitting. */
  pKnown: number;
};

/** Why this card is in the queue. Carried through to the client. */
export type QueueKind = "review" | "boundary" | "fresh";

export type QueueEntry = {
  cardId: string | null;
  wordId: string;
  exerciseType: ExerciseType;
  kind: QueueKind;
};

export type QueueLimits = {
  /** Remaining allowance today, not the profile setting. */
  reviewsLeft: number;
  newLeft: number;
  targetCards: number;
};

/**
 * Above this P(known), the assessment already seeded a card, so anything left
 * over is below it by construction. Mirrors `BOUNDARY_THRESHOLD` in
 * `lib/assessment/seed.ts` — same number, same meaning, stated in both places
 * because they are two different decisions that happen to agree.
 */
export const BOUNDARY_P = 0.5;

/**
 * The minimum gap between two cards for the same word.
 *
 * At M4 every word has exactly one card, so this constraint is never binding
 * and the function that enforces it looks like dead weight. It stops looking
 * that way at M5 and M6, when `listening` and `production` cards for the same
 * word enter the same queue and answering a word twice in a row turns the
 * second one into a copying exercise.
 */
export const MIN_WORD_GAP = 5;

export function buildQueue(
  due: DueCard[],
  candidates: NewCandidate[],
  limits: QueueLimits,
  now: Date,
): QueueEntry[] {
  const reviews: QueueEntry[] = [...due]
    .filter((card) => card.due.getTime() <= now.getTime())
    .sort((a, b) => a.due.getTime() - b.due.getTime() || compareIds(a.cardId, b.cardId))
    .slice(0, Math.max(0, limits.reviewsLeft))
    .map((card) => ({
      cardId: card.cardId,
      wordId: card.wordId,
      exerciseType: card.exerciseType,
      kind: "review" as const,
    }));

  // Boundary words first, most-probably-known first inside that group; then
  // genuinely new words in frequency order. Sorting the whole list by pKnown
  // would look equivalent and is not: below the boundary the curve is flat and
  // noisy, so it would order the unknown words by an estimate that carries no
  // information, throwing away the frequency ordering that does.
  const fresh: QueueEntry[] = [...candidates]
    .sort((a, b) => {
      const aBoundary = a.pKnown >= BOUNDARY_P;
      const bBoundary = b.pKnown >= BOUNDARY_P;
      if (aBoundary !== bBoundary) return aBoundary ? -1 : 1;
      if (aBoundary) return b.pKnown - a.pKnown || byRank(a, b);
      return byRank(a, b);
    })
    .slice(0, Math.max(0, limits.newLeft))
    .map((candidate) => ({
      cardId: candidate.cardId,
      wordId: candidate.wordId,
      exerciseType: candidate.exerciseType,
      kind: candidate.pKnown >= BOUNDARY_P ? ("boundary" as const) : ("fresh" as const),
    }));

  return spaceByWord(interleave(reviews, fresh, limits.targetCards));
}

function byRank(a: NewCandidate, b: NewCandidate): number {
  // A missing rank sorts last rather than to the front. `?? 0` here would put
  // every unranked word at the head of the deck — the same shape of bug that
  // silently disabled stage 1b's fallback.
  const left = a.freqRank ?? Number.MAX_SAFE_INTEGER;
  const right = b.freqRank ?? Number.MAX_SAFE_INTEGER;
  return left - right || compareIds(a.wordId, b.wordId);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * New cards spread evenly through the reviews rather than bolted on either end.
 *
 * All-new-first front-loads the hardest cards onto a cold learner;
 * all-new-last means a short session never reaches them, so the deck stops
 * growing on exactly the days someone is busy.
 */
function interleave(reviews: QueueEntry[], fresh: QueueEntry[], target: number): QueueEntry[] {
  const total = Math.min(target, reviews.length + fresh.length);
  if (total === 0) return [];

  // Keep the ratio of the two pools within the truncated session, so a
  // 20-card session out of 60 available still contains its share of new words.
  const newShare = Math.min(fresh.length, Math.round((fresh.length / (reviews.length + fresh.length)) * total));
  const reviewShare = total - newShare;

  const takenReviews = reviews.slice(0, reviewShare);
  const takenFresh = fresh.slice(0, newShare);

  const out: QueueEntry[] = [];
  let r = 0;
  let f = 0;
  for (let i = 0; i < total; i++) {
    // Place a new card whenever fewer of them have been placed than the
    // position warrants. Cheap, stable, and it degrades to "all of one kind"
    // when the other pool is empty.
    const wantNew = takenFresh.length > 0 && (f + 1) / takenFresh.length <= (i + 1) / total;
    if (wantNew && f < takenFresh.length) out.push(takenFresh[f++]);
    else if (r < takenReviews.length) out.push(takenReviews[r++]);
    else if (f < takenFresh.length) out.push(takenFresh[f++]);
  }
  return out;
}

/**
 * Push apart any two entries for the same word that land within `MIN_WORD_GAP`.
 *
 * Greedy and order-preserving: walk the list, and if the next entry repeats a
 * word seen too recently, swap in the nearest later entry that does not. If no
 * such entry exists the original is kept — a queue that is short by one card
 * is better than one that loops.
 */
function spaceByWord(entries: QueueEntry[]): QueueEntry[] {
  const remaining = [...entries];
  const out: QueueEntry[] = [];

  while (remaining.length > 0) {
    const recent = out.slice(-MIN_WORD_GAP + 1).map((entry) => entry.wordId);
    let index = remaining.findIndex((entry) => !recent.includes(entry.wordId));
    if (index === -1) index = 0;
    out.push(remaining.splice(index, 1)[0]);
  }

  return out;
}
