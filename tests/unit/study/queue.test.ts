import { describe, expect, it } from "vitest";

import {
  BOUNDARY_P,
  MIN_WORD_GAP,
  buildQueue,
  type DueCard,
  type NewCandidate,
} from "@/lib/study/queue";

/**
 * PLAN.md §7.1, and the warning attached to it: after a real assessment the
 * learner's deck held 1,219 seeded `Review` cards, 4,381 **boundary** words
 * and 1,483 genuinely new ones — and the middle group is indistinguishable
 * from the last by card state alone.
 *
 * The tests that matter here are the ones that would still pass if the code
 * were wrong for the right-looking reason.
 */

const NOW = new Date("2026-08-18T09:00:00.000Z");
const LIMITS = { reviewsLeft: 120, newLeft: 15, targetCards: 60 };

function due(count: number, spacingMs = 60_000): DueCard[] {
  return Array.from({ length: count }, (_, index) => ({
    cardId: `card_${index}`,
    wordId: `word_r${index}`,
    exerciseType: "recognition" as const,
    due: new Date(NOW.getTime() - (count - index) * spacingMs),
    state: 2,
  }));
}

function candidates(specs: Array<{ rank: number | null; p: number }>): NewCandidate[] {
  return specs.map((spec, index) => ({
    cardId: null,
    wordId: `word_n${index}`,
    exerciseType: "recognition" as const,
    freqRank: spec.rank,
    pKnown: spec.p,
  }));
}

describe("due cards", () => {
  it("come back in due order, oldest first", () => {
    const queue = buildQueue(due(5), [], LIMITS, NOW);
    expect(queue.map((entry) => entry.cardId)).toEqual([
      "card_0", "card_1", "card_2", "card_3", "card_4",
    ]);
  });

  it("exclude anything not yet due", () => {
    const future: DueCard[] = [
      { cardId: "later", wordId: "w", exerciseType: "recognition", due: new Date(NOW.getTime() + 1), state: 2 },
    ];
    expect(buildQueue(future, [], LIMITS, NOW)).toEqual([]);
  });

  it("include a card due at exactly this instant", () => {
    // The boundary condition. `due <= now`, not `<`.
    const exact: DueCard[] = [
      { cardId: "exact", wordId: "w", exerciseType: "recognition", due: NOW, state: 2 },
    ];
    expect(buildQueue(exact, [], LIMITS, NOW)).toHaveLength(1);
  });

  it("respect the remaining review allowance", () => {
    const queue = buildQueue(due(50), [], { ...LIMITS, reviewsLeft: 10 }, NOW);
    expect(queue).toHaveLength(10);
  });

  it("stop entirely when the allowance is used up", () => {
    expect(buildQueue(due(50), [], { ...LIMITS, reviewsLeft: 0 }, NOW)).toEqual([]);
  });
});

describe("boundary words are ordered on purpose, not by accident", () => {
  /**
   * **The failure this guards.** Ordering everything by frequency rank puts
   * the boundary words first *only because* they happen to be the common ones
   * in this learner's data. Give the same code a learner whose half-known
   * words are rare and the accident stops holding.
   *
   * So the deck below is built the wrong way round: the boundary words have
   * the *worst* ranks. Frequency ordering alone would bury them.
   */
  it("puts half-known words first even when they are the rarest in the deck", () => {
    const deck = candidates([
      { rank: 10, p: 0.05 },
      { rank: 20, p: 0.05 },
      { rank: 30, p: 0.05 },
      { rank: 9000, p: 0.75 },
      { rank: 9500, p: 0.65 },
    ]);
    const queue = buildQueue([], deck, { ...LIMITS, newLeft: 5 }, NOW);

    expect(queue.slice(0, 2).map((entry) => entry.kind)).toEqual(["boundary", "boundary"]);
    expect(queue.slice(0, 2).map((entry) => entry.wordId)).toEqual(["word_n3", "word_n4"]);
  });

  it("labels every card, so the UI never calls a half-known word brand new", () => {
    const deck = candidates([
      { rank: 100, p: 0.79 },
      { rank: 200, p: 0.51 },
      { rank: 300, p: 0.49 },
      { rank: 400, p: 0.0 },
    ]);
    const queue = buildQueue([], deck, { ...LIMITS, newLeft: 4 }, NOW);
    expect(queue.map((entry) => entry.kind)).toEqual([
      "boundary", "boundary", "fresh", "fresh",
    ]);
  });

  it("splits exactly at the boundary threshold", () => {
    const deck = candidates([
      { rank: 1, p: BOUNDARY_P },
      { rank: 2, p: BOUNDARY_P - 0.0001 },
    ]);
    const queue = buildQueue([], deck, { ...LIMITS, newLeft: 2 }, NOW);
    expect(queue.map((entry) => entry.kind)).toEqual(["boundary", "fresh"]);
  });

  it("orders boundary words by confidence, then by frequency", () => {
    const deck = candidates([
      { rank: 50, p: 0.6 },
      { rank: 60, p: 0.9 },
      { rank: 70, p: 0.75 },
    ]);
    const queue = buildQueue([], deck, { ...LIMITS, newLeft: 3 }, NOW);
    expect(queue.map((entry) => entry.wordId)).toEqual(["word_n1", "word_n2", "word_n0"]);
  });

  /**
   * Below the boundary the fitted curve is flat and noisy, so P(known) there
   * carries no information. Ordering unknown words by it would throw away the
   * frequency ordering that does — the whole point of stage 1b.
   */
  it("orders genuinely new words by frequency, not by the noise below the boundary", () => {
    const deck = candidates([
      { rank: 900, p: 0.45 },
      { rank: 100, p: 0.05 },
      { rank: 500, p: 0.3 },
    ]);
    const queue = buildQueue([], deck, { ...LIMITS, newLeft: 3 }, NOW);
    expect(queue.map((entry) => entry.wordId)).toEqual(["word_n1", "word_n2", "word_n0"]);
  });

  /**
   * The NaN-comparator shape of bug, in a new costume. `?? 0` here would sort
   * every unranked word to the very front of the deck and open the drill on
   * words the corpora never saw.
   */
  it("sorts an unranked word last rather than first", () => {
    const deck = candidates([
      { rank: null, p: 0.0 },
      { rank: 5000, p: 0.0 },
      { rank: 10, p: 0.0 },
    ]);
    const queue = buildQueue([], deck, { ...LIMITS, newLeft: 3 }, NOW);
    expect(queue.map((entry) => entry.wordId)).toEqual(["word_n2", "word_n1", "word_n0"]);
  });

  it("degrades to a stable order when no ranks exist at all", () => {
    // Every rank absent — the fallback exercised with the primary gone.
    const deck = candidates([{ rank: null, p: 0 }, { rank: null, p: 0 }, { rank: null, p: 0 }]);
    const queue = buildQueue([], deck, { ...LIMITS, newLeft: 3 }, NOW);
    expect(queue.map((entry) => entry.wordId)).toEqual(["word_n0", "word_n1", "word_n2"]);
  });

  it("marks everything fresh when there is no assessment behind the numbers", () => {
    // No sitting means every pKnown is 0. Without a measurement, nothing is
    // half-known — which is the honest answer, not a degraded one.
    const deck = candidates([{ rank: 1, p: 0 }, { rank: 2, p: 0 }]);
    const queue = buildQueue([], deck, { ...LIMITS, newLeft: 2 }, NOW);
    expect(queue.every((entry) => entry.kind === "fresh")).toBe(true);
  });

  it("respects the remaining new-card allowance", () => {
    const deck = candidates(Array.from({ length: 40 }, (_, i) => ({ rank: i + 1, p: 0 })));
    expect(buildQueue([], deck, { ...LIMITS, newLeft: 3 }, NOW)).toHaveLength(3);
    expect(buildQueue([], deck, { ...LIMITS, newLeft: 0 }, NOW)).toHaveLength(0);
  });
});

describe("mixing the two pools", () => {
  it("never exceeds the session target", () => {
    const queue = buildQueue(
      due(100),
      candidates(Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, p: 0 }))),
      { reviewsLeft: 100, newLeft: 50, targetCards: 20 },
      NOW,
    );
    expect(queue).toHaveLength(20);
  });

  it("keeps new cards in a truncated session instead of dropping them", () => {
    // All-reviews-first would mean the deck stops growing on exactly the days
    // someone only has time for twenty cards.
    const queue = buildQueue(
      due(100),
      candidates(Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, p: 0 }))),
      { reviewsLeft: 100, newLeft: 50, targetCards: 20 },
      NOW,
    );
    expect(queue.some((entry) => entry.kind === "fresh")).toBe(true);
    expect(queue.some((entry) => entry.kind === "review")).toBe(true);
  });

  it("does not front-load every new card", () => {
    const queue = buildQueue(
      due(20),
      candidates(Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, p: 0 }))),
      { reviewsLeft: 20, newLeft: 10, targetCards: 30 },
      NOW,
    );
    const firstFive = queue.slice(0, 5).filter((entry) => entry.kind !== "review").length;
    expect(firstFive).toBeLessThan(5);
    expect(queue.filter((entry) => entry.kind !== "review")).toHaveLength(10);
  });

  it("works when one pool is empty", () => {
    expect(buildQueue(due(5), [], LIMITS, NOW)).toHaveLength(5);
    expect(
      buildQueue([], candidates([{ rank: 1, p: 0 }, { rank: 2, p: 0 }]), LIMITS, NOW),
    ).toHaveLength(2);
    expect(buildQueue([], [], LIMITS, NOW)).toEqual([]);
  });

  it("loses no card and invents none", () => {
    const queue = buildQueue(
      due(7),
      candidates(Array.from({ length: 5 }, (_, i) => ({ rank: i + 1, p: 0 }))),
      { reviewsLeft: 7, newLeft: 5, targetCards: 60 },
      NOW,
    );
    expect(queue).toHaveLength(12);
    expect(new Set(queue.map((entry) => entry.wordId)).size).toBe(12);
  });
});

describe("the same word does not come round twice in a row", () => {
  /**
   * At M4 every word has exactly one card, so this constraint is never
   * binding and looks like dead weight. It stops looking that way at M5 and
   * M6, when `listening` and `production` cards for the same word share a
   * queue and answering a word twice in a row turns the second into copying.
   */
  it("spaces two exercise types for one word apart", () => {
    // The two same-word cards are the *oldest*, so due-order would place them
    // adjacent at the head of the queue and there is room after them to space
    // them apart.
    const twoTypes: DueCard[] = [
      { cardId: "a", wordId: "same", exerciseType: "recognition", due: new Date(NOW.getTime() - 900_000), state: 2 },
      { cardId: "b", wordId: "same", exerciseType: "listening", due: new Date(NOW.getTime() - 899_000), state: 2 },
      ...due(6),
    ];
    const queue = buildQueue(twoTypes, [], LIMITS, NOW);
    const positions = queue
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.wordId === "same")
      .map(({ index }) => index);
    expect(positions).toHaveLength(2);
    expect(positions[1] - positions[0]).toBeGreaterThanOrEqual(MIN_WORD_GAP);
  });

  /**
   * The honest limit, asserted so it is a known property rather than a
   * surprise. Spacing is greedy and forward-looking: a repeat that lands in
   * the last few positions has nothing left to swap in, so it stays adjacent.
   * Dropping the card instead would silently shorten the session, which is
   * worse — and at M4 the case cannot arise, because every word has one card.
   */
  it("cannot space a repeat that falls at the very end of the queue", () => {
    const tailRepeat: DueCard[] = [
      ...due(6),
      { cardId: "a", wordId: "same", exerciseType: "recognition", due: NOW, state: 2 },
      { cardId: "b", wordId: "same", exerciseType: "listening", due: NOW, state: 2 },
    ];
    const queue = buildQueue(tailRepeat, [], LIMITS, NOW);
    expect(queue).toHaveLength(8);
    expect(queue.at(-1)?.wordId).toBe("same");
    expect(queue.at(-2)?.wordId).toBe("same");
  });

  it("still returns every card when spacing is impossible", () => {
    // Three cards, all the same word. A queue short by two would be worse than
    // one that repeats — so the constraint yields rather than the content.
    const allSame: DueCard[] = ["a", "b", "c"].map((id, index) => ({
      cardId: id,
      wordId: "same",
      exerciseType: "recognition",
      due: new Date(NOW.getTime() - 10 + index),
      state: 2,
    }));
    expect(buildQueue(allSame, [], LIMITS, NOW)).toHaveLength(3);
  });
});
