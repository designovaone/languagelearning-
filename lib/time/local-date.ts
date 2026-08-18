/**
 * A study day belongs to the learner, never to the server.
 *
 * `daily_activity`, the streak and the nudge are all keyed on `local_date`, a
 * plain date computed in the learner's IANA zone (PLAN.md §4). The server runs
 * UTC; at 23:30 in Berlin it is already tomorrow, and a learner who studied
 * before bed must not lose the day.
 *
 * Every function here takes `now: Date`. Reading the wall clock is the job of
 * `lib/time/clock.ts` alone (CLAUDE.md).
 */

/** `en-CA` is the locale whose short date format is ISO-8601, in every runtime. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The calendar date at `now` in `timeZone`, as `YYYY-MM-DD`.
 *
 * Assembled from `formatToParts` rather than trusting the formatted string.
 * `en-CA` produces ISO order today, but a runtime that ever emitted
 * `2026-08-18, ` or a right-to-left mark would silently produce a `local_date`
 * that no query matches — and nothing would report it, because a string is a
 * string.
 */
export function localDate(now: Date, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  if (year.length !== 4 || month.length !== 2 || day.length !== 2) {
    throw new Error(`Could not read a local date for time zone ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

/**
 * True when an IANA zone name is one this runtime actually knows.
 *
 * A profile carries whatever the browser reported at signup. An unknown zone
 * makes `Intl.DateTimeFormat` throw, which would turn one bad profile row into
 * a 500 on the study session for that learner only — the kind of failure that
 * looks like "the app is broken for her" and like nothing at all for everyone
 * else.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The learner's zone, or the project default when the stored one is unusable. */
export const FALLBACK_TIME_ZONE = "Europe/Berlin";

export function safeTimeZone(timeZone: string | null | undefined): string {
  if (timeZone && isKnownTimeZone(timeZone)) return timeZone;
  return FALLBACK_TIME_ZONE;
}
