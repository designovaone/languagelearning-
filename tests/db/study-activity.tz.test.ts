import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { buildSession, flushReviews, type ReviewInput } from "@/lib/study/session";

import { closeDb, migratedDb } from "./helpers/pglite";
import { seedMinimal } from "./helpers/seed";

/**
 * `*.tz.test.ts` is the selector for `npm run test:tz` — these run under
 * TZ=UTC, TZ=Europe/Berlin and TZ=Pacific/Auckland (CLAUDE.md). Renaming this
 * file drops it from that sweep silently.
 *
 * **The property: a study day belongs to the learner.** `daily_activity` is
 * what the streak will be computed from at M7, and a row written under the
 * server's date instead of the learner's costs someone a streak they earned —
 * quietly, on a specific evening, months from now.
 *
 * Every assertion is an absolute instant and an explicit profile timezone, so
 * all three server timezones must produce identical results.
 */

/** 22:30 UTC — still the 17th in UTC, already the 18th in Berlin. */
const LATE_IN_BERLIN = new Date("2026-08-17T22:30:00.000Z");
function review(cardId: string, overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    cardId,
    idempotencyKey: `k_${cardId}`,
    wasCorrect: true,
    durationMs: 4000,
    answerGiven: "x",
    hintUsed: false,
    offsetMs: 1000,
    ...overrides,
  };
}

async function learner(timezone: string, now: Date) {
  const db = await migratedDb();
  const seed = await seedMinimal(db, { words: 6, timezone });
  const session = await buildSession(db, seed.userId, now);
  return { db, seed, session: session!, cardIds: session!.cards.map((c) => c.cardId) };
}

describe("daily_activity is keyed on the learner's date", () => {
  let f: Awaited<ReturnType<typeof learner>>;

  afterEach(async () => {
    if (f) await closeDb(f.db);
  });

  it("late evening in Berlin counts as the next day", async () => {
    f = await learner("Europe/Berlin", LATE_IN_BERLIN);
    await flushReviews(f.db, f.seed.userId, f.session.sessionId, [review(f.cardIds[0])], LATE_IN_BERLIN);

    const rows = await f.db.select().from(schema.dailyActivity);
    expect(rows).toHaveLength(1);
    // 00:30 on the 18th, local. Not the 17th, which is what UTC would say.
    expect(rows[0].localDate).toBe("2026-08-18");
  });

  it("the same instant is still the 17th for a learner in UTC", async () => {
    f = await learner("UTC", LATE_IN_BERLIN);
    await flushReviews(f.db, f.seed.userId, f.session.sessionId, [review(f.cardIds[0])], LATE_IN_BERLIN);

    const rows = await f.db.select().from(schema.dailyActivity);
    expect(rows[0].localDate).toBe("2026-08-17");
  });

  it("and already the 18th for a learner in Auckland", async () => {
    f = await learner("Pacific/Auckland", LATE_IN_BERLIN);
    await flushReviews(f.db, f.seed.userId, f.session.sessionId, [review(f.cardIds[0])], LATE_IN_BERLIN);

    const rows = await f.db.select().from(schema.dailyActivity);
    expect(rows[0].localDate).toBe("2026-08-18");
  });

  it("splits a session that runs past the learner's midnight across two days", async () => {
    // Started 23:50 Berlin, still going at 00:10. Two calendar days, and the
    // learner earns both.
    const start = new Date("2026-08-17T21:50:00.000Z");
    f = await learner("Europe/Berlin", start);
    await flushReviews(
      f.db,
      f.seed.userId,
      f.session.sessionId,
      [
        review(f.cardIds[0], { offsetMs: 60_000 }),
        review(f.cardIds[1], { idempotencyKey: "k_b", offsetMs: 20 * 60_000 }),
      ],
      new Date("2026-08-17T22:20:00.000Z"),
    );

    const rows = await f.db
      .select()
      .from(schema.dailyActivity)
      .where(eq(schema.dailyActivity.userId, f.seed.userId));
    const byDate = Object.fromEntries(rows.map((row) => [row.localDate, row.cardsDone]));
    expect(byDate).toEqual({ "2026-08-17": 1, "2026-08-18": 1 });
  });

  it("the study_sessions row carries the learner's date, not the server's", async () => {
    f = await learner("Europe/Berlin", LATE_IN_BERLIN);
    const [row] = await f.db.select().from(schema.studySessions);
    expect(row.localDate).toBe("2026-08-18");
  });
});

describe("the daily new-card limit is counted in the learner's day", () => {
  let f: Awaited<ReturnType<typeof learner>>;

  afterEach(async () => {
    if (f) await closeDb(f.db);
  });

  /**
   * The failure this guards: a learner in Berlin studies at 23:00, and at
   * 00:30 the limit has reset for them but not for the server. Counting in the
   * server's day would either hand out a second full allowance or refuse the
   * first — and neither would look like a bug from the outside.
   */
  it("resets at the learner's midnight, not the server's", async () => {
    const beforeMidnight = new Date("2026-08-17T21:30:00.000Z"); // 23:30 Berlin
    const afterMidnight = new Date("2026-08-17T22:30:00.000Z"); // 00:30 Berlin, next day

    f = await learner("Europe/Berlin", beforeMidnight);
    await f.db
      .update(schema.profiles)
      .set({ dailyNewLimit: 2 })
      .where(eq(schema.profiles.userId, f.seed.userId));

    await flushReviews(
      f.db,
      f.seed.userId,
      f.session.sessionId,
      [
        review(f.cardIds[0], { offsetMs: 1000 }),
        review(f.cardIds[1], { idempotencyKey: "k_b", offsetMs: 2000 }),
      ],
      beforeMidnight,
    );

    // Same server day, allowance used up.
    const sameDay = await buildSession(f.db, f.seed.userId, beforeMidnight);
    expect(sameDay!.counts.fresh + sameDay!.counts.boundary).toBe(0);

    // An hour later it is a new day *for the learner*, so the allowance is back.
    const nextDay = await buildSession(f.db, f.seed.userId, afterMidnight);
    expect(nextDay!.counts.fresh + nextDay!.counts.boundary).toBe(2);
  });
});
