import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";

import {
  FAST_FRACTION,
  MIN_SAMPLES_FOR_MEDIAN,
  OUTLIER_CLAMP,
  SLOW_MULTIPLE,
  gradeFor,
  rollingMedian,
} from "@/lib/fsrs/grade";

/**
 * PLAN.md §7.3. The learner is never asked how it went; the grade is derived
 * from what happened.
 *
 * The point of these tests is not that the four branches work — that is a
 * lookup table. It is that the *guards* work: the no-baseline path, the
 * outlier clamp, and the rule that latency alone never says `Again`.
 */

const MEDIAN = 4000;
const correct = (durationMs: number, hintUsed = false) => ({
  wasCorrect: true,
  durationMs,
  hintUsed,
});

describe("the grade mapping", () => {
  it("a wrong answer is Again, however fast", () => {
    expect(gradeFor({ wasCorrect: false, durationMs: 100, hintUsed: false }, MEDIAN)).toBe(
      Rating.Again,
    );
    expect(gradeFor({ wasCorrect: false, durationMs: 90_000, hintUsed: false }, MEDIAN)).toBe(
      Rating.Again,
    );
  });

  it("right and fast is Easy", () => {
    expect(gradeFor(correct(MEDIAN * FAST_FRACTION - 1), MEDIAN)).toBe(Rating.Easy);
  });

  it("right at an ordinary pace is Good", () => {
    expect(gradeFor(correct(MEDIAN), MEDIAN)).toBe(Rating.Good);
    expect(gradeFor(correct(MEDIAN * FAST_FRACTION), MEDIAN)).toBe(Rating.Good);
    expect(gradeFor(correct(MEDIAN * SLOW_MULTIPLE), MEDIAN)).toBe(Rating.Good);
  });

  it("right but slow is Hard", () => {
    expect(gradeFor(correct(MEDIAN * SLOW_MULTIPLE + 1), MEDIAN)).toBe(Rating.Hard);
  });

  it("a hint forces Hard even on a fast answer", () => {
    // A hint is the whole reason the answer arrived. Rewarding it with Easy
    // would push the card out on evidence the learner did not supply.
    expect(gradeFor(correct(10, true), MEDIAN)).toBe(Rating.Hard);
  });

  /**
   * The guard that matters most. Someone answers, then the phone rings.
   * Treating a right answer as forgotten would cost them progress they earned,
   * and it is the kind of loss nobody can see happening.
   */
  it("latency alone never produces Again", () => {
    for (const durationMs of [MEDIAN, MEDIAN * 10, MEDIAN * 1000, 600_000]) {
      expect(gradeFor(correct(durationMs), MEDIAN)).not.toBe(Rating.Again);
    }
  });
});

describe("the no-baseline path — every learner's first session", () => {
  /**
   * The fallback exercised with the primary fully absent. A null median is not
   * an edge case: it is the state of every new account and of every exercise
   * type the first time it is used.
   */
  it("a correct answer is Good when there is no median yet", () => {
    expect(gradeFor(correct(50), null)).toBe(Rating.Good);
    expect(gradeFor(correct(500_000), null)).toBe(Rating.Good);
  });

  it("a wrong answer is still Again with no median", () => {
    expect(gradeFor({ wasCorrect: false, durationMs: 50, hintUsed: false }, null)).toBe(
      Rating.Again,
    );
  });

  it("a hint still forces Hard with no median", () => {
    expect(gradeFor(correct(50, true), null)).toBe(Rating.Hard);
  });

  it("a nonsense median of zero is treated as no median, not as infinitely slow", () => {
    // Dividing the world by a zero median would make every answer "slow".
    expect(gradeFor(correct(1), 0)).toBe(Rating.Good);
    expect(gradeFor(correct(100_000), 0)).toBe(Rating.Good);
  });
});

describe("the rolling median", () => {
  it("is null below the minimum sample size", () => {
    const durations = Array.from({ length: MIN_SAMPLES_FOR_MEDIAN - 1 }, () => 3000);
    expect(rollingMedian(durations)).toBeNull();
    expect(rollingMedian([])).toBeNull();
  });

  it("is a number at exactly the minimum", () => {
    const durations = Array.from({ length: MIN_SAMPLES_FOR_MEDIAN }, () => 3000);
    expect(rollingMedian(durations)).toBe(3000);
  });

  /**
   * The failure this guards: one interrupted card dragging the baseline.
   * Without the clamp a single eleven-minute duration in a short session moves
   * the median far enough that ordinary answers start scoring `Easy`.
   */
  it("clamps an outlier instead of letting it move the baseline", () => {
    const ordinary = Array.from({ length: 10 }, () => 3000);
    const withOutlier = [...ordinary, 11 * 60 * 1000];
    const clamped = rollingMedian(withOutlier);
    expect(clamped).toBeLessThanOrEqual(3000 * OUTLIER_CLAMP);
    expect(clamped).toBe(3000);
  });

  it("survives a session that is mostly outliers", () => {
    const durations = [1000, 1000, 1000, 1000, 1000, 900_000, 900_000, 900_000, 900_000, 900_000];
    const value = rollingMedian(durations);
    expect(value).not.toBeNull();
    expect(Number.isFinite(value)).toBe(true);
  });

  it("takes the mean of the middle two on an even count", () => {
    expect(rollingMedian([1000, 1000, 1000, 1000, 2000, 2000, 2000, 2000, 2000, 2000])).toBe(2000);
  });
});
