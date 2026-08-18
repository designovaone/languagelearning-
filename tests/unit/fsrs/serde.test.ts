import { describe, expect, it } from "vitest";
import { State, createEmptyCard } from "ts-fsrs";

import { emptyCardState, fromFsrsCard, toFsrsCard, type CardState } from "@/lib/fsrs/serde";

/**
 * The schema stores one column per FSRS field (PLAN.md §4). The risk in that
 * choice is a field quietly lost in one direction: a dropped `lapses` or
 * `learning_steps` throws nothing and schedules slightly wrong forever.
 *
 * So this file asserts the mapping is total in both directions, and does it by
 * comparing key sets rather than by listing the fields — a hand-written list
 * would have to be updated by the same person who forgot the field.
 */

const NOW = new Date("2026-08-18T09:00:00.000Z");

const populated: CardState = {
  due: new Date("2026-09-01T09:00:00.000Z"),
  stability: 12.5,
  difficulty: 6.25,
  elapsedDays: 3,
  scheduledDays: 14,
  learningSteps: 2,
  reps: 9,
  lapses: 1,
  state: State.Review,
  lastReview: new Date("2026-08-18T09:00:00.000Z"),
};

describe("card row ⇄ ts-fsrs Card", () => {
  it("round-trips every field unchanged", () => {
    expect(fromFsrsCard(toFsrsCard(populated))).toEqual(populated);
  });

  it("covers every field ts-fsrs itself puts on a Card", () => {
    // The real guard. If ts-fsrs gains a field, this fails; a fixed list of
    // property assertions would not.
    const theirs = Object.keys(createEmptyCard(NOW)).sort();
    const ours = Object.keys(toFsrsCard(populated)).sort();
    // `last_review` is optional on their type and absent on an empty card.
    expect(ours.filter((key) => key !== "last_review")).toEqual(
      theirs.filter((key) => key !== "last_review"),
    );
  });

  it("maps a never-reviewed card to undefined, not to a bogus date", () => {
    const fresh = emptyCardState(NOW);
    expect(toFsrsCard(fresh).last_review).toBeUndefined();
    expect(fromFsrsCard(toFsrsCard(fresh)).lastReview).toBeNull();
  });

  it("starts a new card in State.New, due now", () => {
    const fresh = emptyCardState(NOW);
    expect(fresh.state).toBe(State.New);
    expect(fresh.due.toISOString()).toBe(NOW.toISOString());
    expect(fresh.reps).toBe(0);
    expect(fresh.lapses).toBe(0);
  });

  it("matches what ts-fsrs would have produced for an empty card", () => {
    // `createEmptyCard` reads the wall clock, which this project forbids
    // outside lib/time/clock.ts — hence our own. Same shape, checked here so
    // "same shape" is a fact rather than a claim.
    const theirs = createEmptyCard(NOW);
    const ours = toFsrsCard(emptyCardState(NOW));
    expect(ours).toEqual(theirs);
  });
});
