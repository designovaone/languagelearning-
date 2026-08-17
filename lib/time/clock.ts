/**
 * The only place in this codebase allowed to read the wall clock.
 *
 * Everything else — every scheduler, every streak calculation, every queue
 * builder — takes `now: Date` as an argument. That makes those functions pure,
 * which makes them testable without fake timers and replayable after the fact.
 *
 * Enforced two ways: an ESLint `no-restricted-syntax` rule (see
 * `eslint.config.mjs`) and a grep test over git-tracked sources
 * (`tests/unit/discipline/no-wall-clock.test.ts`). Both point here.
 *
 * See PLAN.md §3 and §12.
 */

export interface Clock {
  /** The current instant. */
  now(): Date;
}

/** Reads the real system clock. Wire this in at the edge — routes, jobs, entry points. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * A clock frozen at one instant. Returns a fresh `Date` each call, so a caller
 * mutating the result cannot move the clock for everyone else.
 */
export function fixedClock(instant: Date): Clock {
  const frozenMs = instant.getTime();
  return { now: () => new Date(frozenMs) };
}

/**
 * A clock that advances by a fixed step on every read. Useful for simulating a
 * study session where each card takes a plausible amount of time.
 */
export function steppingClock(start: Date, stepMs: number): Clock {
  let currentMs = start.getTime();
  return {
    now: () => {
      const at = new Date(currentMs);
      currentMs += stepMs;
      return at;
    },
  };
}
