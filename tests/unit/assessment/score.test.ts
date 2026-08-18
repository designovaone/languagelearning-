import { describe, expect, it } from "vitest";

import {
  bandCurve,
  calibrate,
  calibration,
  estimateSize,
  scorePartA,
  type AnsweredItem,
  type RecallItem,
} from "@/lib/assessment/score";

/**
 * PLAN.md §6. The headline requirement is stated as a behaviour rather than a
 * formula: **a learner who taps "I know this" on everything must be scored
 * down, not placed at C2.** That is the test the whole design exists to pass,
 * so it is the first one here.
 */

function items(
  spec: Array<[isReal: boolean, band: number | null, known: boolean]>,
): AnsweredItem[] {
  return spec.map(([isReal, bandNumber, answeredKnown]) => ({
    isReal,
    bandNumber,
    answeredKnown,
  }));
}

describe("scorePartA", () => {
  it("scores an over-claimer near zero, not near perfect", () => {
    const everything = items([
      ...Array.from({ length: 40 }, () => [true, 1, true] as [boolean, number, boolean]),
      ...Array.from({ length: 20 }, () => [false, null, true] as [boolean, null, boolean]),
    ]);
    const score = scorePartA(everything);
    expect(score.hitRate).toBe(1);
    expect(score.falseAlarmRate).toBe(1);
    expect(score.correctedScore).toBe(0);
  });

  it("scores an honest learner by what they actually knew", () => {
    const honest = items([
      ...Array.from({ length: 30 }, () => [true, 1, true] as [boolean, number, boolean]),
      ...Array.from({ length: 10 }, () => [true, 5, false] as [boolean, number, boolean]),
      ...Array.from({ length: 20 }, () => [false, null, false] as [boolean, null, boolean]),
    ]);
    const score = scorePartA(honest);
    expect(score.hitRate).toBeCloseTo(0.75);
    expect(score.falseAlarmRate).toBe(0);
    expect(score.correctedScore).toBeCloseTo(0.75);
  });

  it("can go negative when the traps are claimed more than the real words", () => {
    const score = scorePartA(
      items([
        [true, 1, false],
        [true, 1, false],
        [false, null, true],
      ]),
    );
    expect(score.correctedScore).toBeLessThan(0);
  });

  it("REFUSES to score a sitting with no pseudowords", () => {
    // Defaulting the false-alarm rate to zero here would turn raw self-report
    // into something that reads as a corrected measurement. The number would
    // be inflated and nothing downstream would ever report it.
    expect(() => scorePartA(items([[true, 1, true]]))).toThrow(/pseudowords/);
  });

  it("refuses to score a sitting with no real words", () => {
    expect(() => scorePartA(items([[false, null, false]]))).toThrow(/real words/);
  });
});

describe("bandCurve", () => {
  it("is the raw rate when nobody over-claims", () => {
    const curve = bandCurve(
      items([
        [true, 1, true],
        [true, 1, true],
        [true, 2, true],
        [true, 2, false],
      ]),
      0,
    );
    expect(curve[1]).toBe(1);
    expect(curve[2]).toBe(0.5);
  });

  it("discounts a band in proportion to the false-alarm rate", () => {
    // Claimed 3 of 4 in the band, but claimed half the traps too. Corrected:
    // (0.75 − 0.5) / (1 − 0.5) = 0.5.
    const curve = bandCurve(
      items([
        [true, 1, true],
        [true, 1, true],
        [true, 1, true],
        [true, 1, false],
      ]),
      0.5,
    );
    expect(curve[1]).toBeCloseTo(0.5);
  });

  it("yields zero for every band when every trap was claimed", () => {
    const curve = bandCurve(items([[true, 1, true], [true, 2, true]]), 1);
    expect(curve[1]).toBe(0);
    expect(curve[2]).toBe(0);
  });

  it("never returns a probability outside 0..1", () => {
    const curve = bandCurve(items([[true, 1, false], [true, 1, false]]), 0.9);
    expect(curve[1]).toBeGreaterThanOrEqual(0);
    expect(curve[1]).toBeLessThanOrEqual(1);
  });

  it("omits a band that was never sampled rather than guessing it", () => {
    const curve = bandCurve(items([[true, 1, true]]), 0);
    expect(curve[3]).toBeUndefined();
  });
});

describe("calibration", () => {
  const recall = (spec: Array<[claimed: boolean, correct: boolean]>): RecallItem[] =>
    spec.map(([claimedKnown, correct]) => ({ bandNumber: 2, claimedKnown, correct }));

  it("is 1 when every claimed word came back correct", () => {
    expect(calibration(recall([[true, true], [true, true]]))).toBe(1);
  });

  it("falls below 1 when claims do not survive measurement", () => {
    expect(calibration(recall([[true, true], [true, false]]))).toBe(0.5);
  });

  it("ignores words the learner never claimed", () => {
    expect(calibration(recall([[true, true], [false, false]]))).toBe(1);
  });

  it("returns null — not 1 — when nothing was both claimed and tested", () => {
    // Returning 1 would silently assert the learner was accurate, which is
    // exactly the unverified claim this whole part exists to replace.
    expect(calibration(recall([[false, false]]))).toBeNull();
  });

  it("leaves the curve untouched when there is nothing to calibrate", () => {
    expect(calibrate({ 1: 0.9, 2: 0.4 }, null)).toEqual({ 1: 0.9, 2: 0.4 });
  });

  it("scales every band by the factor", () => {
    expect(calibrate({ 1: 0.8, 2: 0.4 }, 0.5)).toEqual({ 1: 0.4, 2: 0.2 });
  });
});

describe("estimateSize", () => {
  it("weights each band by how many words it holds", () => {
    expect(estimateSize({ 1: 1, 2: 0.5 }, { 1: 2000, 2: 3000 })).toBe(3500);
  });

  it("counts an unsampled band as zero rather than interpolating", () => {
    expect(estimateSize({ 1: 1 }, { 1: 2000, 2: 3000 })).toBe(2000);
  });

  it("gives an over-claimer an estimate near zero", () => {
    const everything = items([
      ...Array.from({ length: 40 }, () => [true, 1, true] as [boolean, number, boolean]),
      ...Array.from({ length: 20 }, () => [false, null, true] as [boolean, null, boolean]),
    ]);
    const { falseAlarmRate } = scorePartA(everything);
    const size = estimateSize(bandCurve(everything, falseAlarmRate), { 1: 7000 });
    expect(size).toBe(0);
  });
});
