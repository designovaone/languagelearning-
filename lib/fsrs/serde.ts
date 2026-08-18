/**
 * The card row ⇄ `ts-fsrs` `Card` translation, in one place.
 *
 * The schema stores one column per FSRS field rather than a JSON blob
 * (PLAN.md §4), which makes the hot query indexable and every field
 * inspectable in SQL. The price is this conversion, and the risk is that a
 * field gets dropped in one direction and nobody notices: a lost `lapses` or
 * `learning_steps` does not throw, it just schedules slightly wrong forever.
 *
 * So the mapping is explicit both ways and round-tripped by a test.
 */

import { State, type Card } from "ts-fsrs";

/** Exactly the FSRS-owned columns of `cards`. Nothing else belongs here. */
export type CardState = {
  due: Date;
  stability: number;
  difficulty: number;
  /** Deprecated in ts-fsrs 6.0. Written because 5.x writes it; never read. */
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: Date | null;
};

export function toFsrsCard(row: CardState): Card {
  return {
    due: row.due,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsedDays,
    scheduled_days: row.scheduledDays,
    learning_steps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state as State,
    last_review: row.lastReview ?? undefined,
  };
}

export function fromFsrsCard(card: Card): CardState {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review ?? null,
  };
}

/**
 * The state a word starts in when it has never been seen.
 *
 * Deliberately *not* `createEmptyCard()` from ts-fsrs: that helper reads the
 * wall clock for `due`, which this project forbids outside
 * `lib/time/clock.ts`. Same shape, `now` passed in.
 */
export function emptyCardState(now: Date): CardState {
  return {
    due: now,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    lastReview: null,
  };
}
