import { describe, expect, it } from "vitest";
import { Rating, State } from "ts-fsrs";

import { gradeFor, type RawSignal } from "@/lib/fsrs/grade";
import { replay, type LoggedReview } from "@/lib/fsrs/replay";
import { applyReview } from "@/lib/fsrs/scheduler";
import { emptyCardState, type CardState } from "@/lib/fsrs/serde";

/**
 * PLAN.md §7.4: *"replaying a session's review log server-side yields the same
 * final card states regardless of how flushes were batched."*
 *
 * This is the pure half of that invariant; `tests/db/study-flush.test.ts` runs
 * the same claim through the real endpoint and a real database. Both are worth
 * having: this one localises a break to the scheduler, that one to the wiring.
 */

const START = new Date("2026-08-18T09:00:00.000Z");

function log(count: number, everyMs = 8000): LoggedReview[] {
  return Array.from({ length: count }, (_, index) => ({
    cardId: `card_${index % 3}`,
    idempotencyKey: `key_${index}`,
    reviewedAt: new Date(START.getTime() + index * everyMs),
    wasCorrect: index % 4 !== 3,
    durationMs: 3000 + (index % 5) * 500,
    hintUsed: index % 7 === 0,
  }));
}

function startingStates(ids: string[]): Map<string, CardState> {
  return new Map(ids.map((id) => [id, emptyCardState(START)]));
}

/** Split a log into batches of the given sizes, in order. */
function chunk<T>(items: T[], sizes: number[]): T[][] {
  const out: T[][] = [];
  let index = 0;
  for (const size of sizes) {
    out.push(items.slice(index, index + size));
    index += size;
  }
  if (index < items.length) out.push(items.slice(index));
  return out;
}

describe("the replay invariant", () => {
  const entries = log(24);
  const ids = ["card_0", "card_1", "card_2"];

  it("one batch and many batches agree", () => {
    const whole = replay(entries, startingStates(ids));

    for (const sizes of [[24], [1], [10, 10, 4], [23, 1], [5, 5, 5, 5, 4], [2, 7, 1, 14]]) {
      let states = startingStates(ids);
      for (const batch of chunk(entries, sizes)) states = replay(batch, states);
      for (const id of ids) {
        expect(states.get(id), `batching ${sizes.join("+")} changed ${id}`).toEqual(whole.get(id));
      }
    }
  });

  it("does not depend on the order the reviews were listed in", () => {
    // Ordering is by `reviewedAt`, so shuffling the array must change nothing.
    const whole = replay(entries, startingStates(ids));
    const shuffled = [...entries].reverse();
    for (const id of ids) {
      expect(replay(shuffled, startingStates(ids)).get(id)).toEqual(whole.get(id));
    }
  });

  /**
   * **The limit of the invariant, asserted rather than assumed.**
   *
   * The guarantee is over *batching*, not over arrival order. FSRS is
   * order-dependent by construction — an interval is computed from the state
   * the card was in — so folding a later batch into an earlier state produces
   * a different, wrong answer. Nothing throws when that happens.
   *
   * This is exactly why the client chains its flushes through a single promise
   * instead of firing them in parallel, and why that chaining is a correctness
   * requirement rather than politeness towards the network. A test that only
   * showed the happy path would leave the reason invisible, and the next
   * person to "optimise" the flush would remove it.
   */
  it("a batch folded in out of order gives a different answer — hence the chained flush", () => {
    const batches = chunk(entries, [8, 8, 8]);

    let inOrder = startingStates(ids);
    for (const batch of batches) inOrder = replay(batch, inOrder);

    let outOfOrder = startingStates(ids);
    for (const batch of [batches[2], batches[0], batches[1]]) {
      outOfOrder = replay(batch, outOfOrder);
    }

    expect(outOfOrder.get("card_0")).not.toEqual(inOrder.get("card_0"));

    // And the fix is not to hope: hand the whole log over at once and the
    // order it arrived in stops mattering.
    const recovered = replay([...batches[2], ...batches[0], ...batches[1]], startingStates(ids));
    for (const id of ids) expect(recovered.get(id)).toEqual(inOrder.get(id));
  });

  it("is deterministic — the same log twice gives the same states", () => {
    // Fuzz would break this by a few percent, which is exactly the amount of
    // wrong that never gets noticed. `scheduler.ts` disables it explicitly.
    expect(replay(entries, startingStates(ids))).toEqual(replay(entries, startingStates(ids)));
  });

  it("breaks ties on the idempotency key rather than on array order", () => {
    const sameInstant: LoggedReview[] = [
      { cardId: "c", idempotencyKey: "b", reviewedAt: START, wasCorrect: true, durationMs: 1000, hintUsed: false },
      { cardId: "c", idempotencyKey: "a", reviewedAt: START, wasCorrect: false, durationMs: 1000, hintUsed: false },
    ];
    const forwards = replay(sameInstant, startingStates(["c"]));
    const backwards = replay([...sameInstant].reverse(), startingStates(["c"]));
    expect(forwards).toEqual(backwards);
  });

  it("treats a card with no starting state as brand new", () => {
    const states = replay(log(3), new Map());
    expect(states.size).toBeGreaterThan(0);
    for (const state of states.values()) expect(state.reps).toBeGreaterThan(0);
  });
});

describe("replay under a different grade mapping", () => {
  /**
   * The escape hatch from PLAN.md §7.3. The 40%-of-median rule is a judgement
   * call; because the raw signal is stored, a new rule can be run over the
   * whole history. That is only true if replay accepts a different grader, so
   * it is tested rather than assumed.
   */
  it("produces different states from the same raw signal", () => {
    const entries = log(12);
    const ids = ["card_0", "card_1", "card_2"];

    const current = replay(entries, startingStates(ids));
    const harsher = replay(entries, startingStates(ids), {
      grader: (signal: RawSignal) => (signal.wasCorrect ? Rating.Hard : Rating.Again),
    });

    expect(harsher.get("card_0")).not.toEqual(current.get("card_0"));
    // And the raw log is untouched by either run.
    expect(entries[0].wasCorrect).toBe(true);
  });

  it("the default grader is the one shipped in grade.ts", () => {
    const single: LoggedReview[] = [
      { cardId: "c", idempotencyKey: "k", reviewedAt: START, wasCorrect: true, durationMs: 3000, hintUsed: false },
    ];
    const viaReplay = replay(single, startingStates(["c"])).get("c");
    const direct = applyReview(
      emptyCardState(START),
      gradeFor({ wasCorrect: true, durationMs: 3000, hintUsed: false }, null),
      START,
    ).next;
    expect(viaReplay).toEqual(direct);
  });
});

describe("the scheduler itself", () => {
  it("Again on a review card creates a lapse and pulls the card back in", () => {
    const reviewCard: CardState = {
      ...emptyCardState(START),
      state: State.Review,
      stability: 20,
      difficulty: 5,
      due: new Date(START.getTime() + 20 * 86_400_000),
      reps: 4,
      lastReview: START,
    };
    const { next } = applyReview(reviewCard, Rating.Again, new Date(START.getTime() + 86_400_000));
    expect(next.lapses).toBe(1);
    expect(next.due.getTime()).toBeLessThan(reviewCard.due.getTime());
  });

  /**
   * **The assertion that keeps "done for today" honest.**
   *
   * With ts-fsrs's default 1m/10m learning steps, a new card answered `Good`
   * is due again in ten minutes and stays in `Learning`. A session here is
   * about two minutes long, so the app would show the "nothing is due" screen
   * — the one PLAN.md §7.2 calls the point of the whole project — while
   * fifteen cards were due before the kettle boiled.
   *
   * The parameter that prevents that is one word in a config object, which is
   * exactly the kind of thing a future dependency bump resets. So the
   * behaviour is asserted, not the setting.
   */
  it("a new card answered correctly does not come back the same day", () => {
    const { next } = applyReview(emptyCardState(START), Rating.Good, START);
    expect(next.state).toBe(State.Review);
    const hours = (next.due.getTime() - START.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(24);
  });

  it("a new card answered wrong comes back tomorrow, not in a minute", () => {
    // The immediate correction is the drill's job — it re-queues a wrong card
    // inside the session. The scheduler's job is the next *day*.
    const { next } = applyReview(emptyCardState(START), Rating.Again, START);
    const hours = (next.due.getTime() - START.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(12);
  });

  it("records the state the card was in before the review, not after", () => {
    // The "before" columns on `reviews` are what makes a replay verifiable.
    // ts-fsrs's own ReviewLog.due is `last_review || due`, which is not the
    // same thing, so these are read off the input card instead.
    const before = emptyCardState(START);
    const { log: entry } = applyReview(before, Rating.Good, START);
    expect(entry.stateBefore).toBe(State.New);
    expect(entry.dueBefore.toISOString()).toBe(START.toISOString());
    expect(entry.stabilityBefore).toBe(0);
  });
});
