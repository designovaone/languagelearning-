import { describe, expect, it } from "vitest";

import {
  FALLBACK_TIME_ZONE,
  isKnownTimeZone,
  localDate,
  safeTimeZone,
} from "@/lib/time/local-date";

/**
 * `*.tz.test.ts` is the selector for `npm run test:tz`, which runs these files
 * under TZ=UTC, TZ=Europe/Berlin and TZ=Pacific/Auckland (CLAUDE.md). Renaming
 * this file silently drops it from that sweep.
 *
 * The property under test is the one the streak and the daily limits rest on:
 * **nothing here may depend on the server's own timezone.** Every assertion
 * below is an absolute instant and an explicit zone, so all three runs must
 * agree — and if one day they do not, a learner lost a day they had earned.
 */

describe("local dates belong to the learner, not the server", () => {
  it("gives the calendar date in the learner's zone", () => {
    const at = new Date("2026-08-17T12:00:00.000Z");
    expect(localDate(at, "Europe/Berlin")).toBe("2026-08-17");
    expect(localDate(at, "UTC")).toBe("2026-08-17");
    expect(localDate(at, "Pacific/Auckland")).toBe("2026-08-18");
  });

  it("late evening in Berlin is already tomorrow there and not in UTC", () => {
    // 22:30 UTC is 00:30 Berlin in summer. A learner studying before bed must
    // get credit for the day they think it is.
    const at = new Date("2026-08-17T22:30:00.000Z");
    expect(localDate(at, "UTC")).toBe("2026-08-17");
    expect(localDate(at, "Europe/Berlin")).toBe("2026-08-18");
  });

  it("handles the spring DST transition in Berlin", () => {
    // 00:30 UTC on 29 March 2026 is 01:30 local (UTC+1); an hour later the
    // clocks jump to 03:30 (UTC+2). Both are the same calendar date.
    expect(localDate(new Date("2026-03-29T00:30:00.000Z"), "Europe/Berlin")).toBe("2026-03-29");
    expect(localDate(new Date("2026-03-29T01:30:00.000Z"), "Europe/Berlin")).toBe("2026-03-29");
  });

  it("handles the autumn DST transition in Berlin", () => {
    expect(localDate(new Date("2026-10-25T00:30:00.000Z"), "Europe/Berlin")).toBe("2026-10-25");
    expect(localDate(new Date("2026-10-25T23:30:00.000Z"), "Europe/Berlin")).toBe("2026-10-26");
  });

  it("crosses midnight at the right instant in each zone", () => {
    const justBefore = new Date("2026-08-17T21:59:59.999Z");
    const justAfter = new Date("2026-08-17T22:00:00.000Z");
    expect(localDate(justBefore, "Europe/Berlin")).toBe("2026-08-17");
    expect(localDate(justAfter, "Europe/Berlin")).toBe("2026-08-18");
  });

  it("pads single-digit months and days", () => {
    // A `local_date` of "2026-1-5" matches no row and throws no error. The
    // format is load-bearing, so it is asserted rather than assumed.
    expect(localDate(new Date("2026-01-05T12:00:00.000Z"), "UTC")).toBe("2026-01-05");
  });

  it("is stable across years and leap days", () => {
    expect(localDate(new Date("2028-02-29T12:00:00.000Z"), "UTC")).toBe("2028-02-29");
    expect(localDate(new Date("2026-12-31T23:30:00.000Z"), "Pacific/Auckland")).toBe("2027-01-01");
  });
});

describe("an unusable stored zone degrades instead of failing", () => {
  /**
   * The failure this guards. A profile carries whatever the browser reported
   * at signup. One bad value would make `Intl.DateTimeFormat` throw inside the
   * study session — a 500 for that learner and a working app for everyone
   * else, which reads as "it is broken on her phone".
   */
  it("recognises a real zone and rejects a made-up one", () => {
    expect(isKnownTimeZone("Europe/Berlin")).toBe(true);
    expect(isKnownTimeZone("Mars/Olympus_Mons")).toBe(false);
  });

  it("falls back rather than throwing", () => {
    expect(safeTimeZone("Mars/Olympus_Mons")).toBe(FALLBACK_TIME_ZONE);
    expect(safeTimeZone(null)).toBe(FALLBACK_TIME_ZONE);
    expect(safeTimeZone(undefined)).toBe(FALLBACK_TIME_ZONE);
    expect(safeTimeZone("")).toBe(FALLBACK_TIME_ZONE);
  });

  it("keeps a zone it does recognise", () => {
    expect(safeTimeZone("Pacific/Auckland")).toBe("Pacific/Auckland");
  });

  it("the fallback path produces a usable date", () => {
    // Exercising the fallback with the primary fully absent: this is the code
    // that runs on the day something goes wrong, which is the day nobody is
    // watching.
    const zone = safeTimeZone("not/a/zone");
    expect(localDate(new Date("2026-08-17T22:30:00.000Z"), zone)).toBe("2026-08-18");
  });
});
