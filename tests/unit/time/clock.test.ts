import { describe, expect, it } from "vitest";

import { fixedClock, steppingClock, systemClock } from "@/lib/time/clock";

const T0 = new Date("2026-08-17T12:00:00.000Z");

describe("fixedClock", () => {
  it("returns the same instant every time", () => {
    const clock = fixedClock(T0);
    expect(clock.now().toISOString()).toBe(T0.toISOString());
    expect(clock.now().toISOString()).toBe(T0.toISOString());
  });

  it("hands out a fresh Date, so a caller cannot move the clock by mutating it", () => {
    const clock = fixedClock(T0);
    const first = clock.now();
    first.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe(T0.toISOString());
  });

  it("is not affected by mutating the Date it was constructed from", () => {
    const seed = new Date(T0);
    const clock = fixedClock(seed);
    seed.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe(T0.toISOString());
  });
});

describe("steppingClock", () => {
  it("advances by the step on each read", () => {
    const clock = steppingClock(T0, 1_500);
    expect(clock.now().toISOString()).toBe("2026-08-17T12:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-08-17T12:00:01.500Z");
    expect(clock.now().toISOString()).toBe("2026-08-17T12:00:03.000Z");
  });
});

describe("systemClock", () => {
  it("reads a plausible current instant", () => {
    const before = performance.timeOrigin + performance.now();
    const observed = systemClock.now().getTime();
    const after = performance.timeOrigin + performance.now();
    // Generous bounds: this asserts the clock is wired to the real time source,
    // not that it is precise.
    expect(observed).toBeGreaterThanOrEqual(Math.floor(before) - 1_000);
    expect(observed).toBeLessThanOrEqual(Math.ceil(after) + 1_000);
  });
});
