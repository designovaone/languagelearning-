import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rating, State } from "ts-fsrs";

import * as schema from "@/lib/db/schema";
import { buildSession, flushReviews, type ReviewInput } from "@/lib/study/session";

import { closeDb, migratedDb, type TestDatabase } from "./helpers/pglite";
import { seedMinimal, type Seed } from "./helpers/seed";

/**
 * PLAN.md §7.4, against real Postgres.
 *
 * The two properties the flush has to have, and both of them are the kind that
 * fail silently:
 *
 * 1. **Double-flushing a batch changes nothing.** Not "does not error" —
 *    changes nothing. A retried batch that re-applies FSRS pushes a week of
 *    reviews into next month and reports success.
 * 2. **The final card states do not depend on how the flushes were batched.**
 *    Batch boundaries are decided by network luck and by when the learner put
 *    the phone down. If they moved the schedule, the schedule would be a
 *    function of the connection.
 */

const NOW = new Date("2026-08-18T09:00:00.000Z");
const LATER = new Date("2026-08-18T09:30:00.000Z");

type Fixture = { db: TestDatabase; seed: Seed; sessionId: string; cardIds: string[] };

async function openSession(words = 12): Promise<Fixture> {
  const db = await migratedDb();
  const seed = await seedMinimal(db, { words });
  const session = await buildSession(db, seed.userId, NOW);
  return {
    db,
    seed,
    sessionId: session!.sessionId,
    cardIds: session!.cards.map((card) => card.cardId),
  };
}

function review(cardId: string, index: number, overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    cardId,
    idempotencyKey: `k_${cardId}_1`,
    wasCorrect: index % 3 !== 2,
    durationMs: 3000 + index * 100,
    answerGiven: `answer ${index}`,
    hintUsed: false,
    offsetMs: (index + 1) * 5000,
    ...overrides,
  };
}

/** Every FSRS-owned column, for comparing two runs. */
async function cardStates(db: TestDatabase, userId: string) {
  const rows = await db
    .select()
    .from(schema.cards)
    .where(eq(schema.cards.userId, userId))
    .orderBy(asc(schema.cards.id));
  return rows.map((row) => ({
    id: row.id,
    due: row.due?.toISOString(),
    stability: row.stability,
    difficulty: row.difficulty,
    scheduledDays: row.scheduledDays,
    learningSteps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    lastReview: row.lastReview?.toISOString() ?? null,
  }));
}

describe("a flush writes cards and reviews together", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await openSession(4);
  });

  afterEach(async () => {
    await closeDb(f.db);
  });

  it("advances the card and logs the review", async () => {
    const result = await flushReviews(
      f.db,
      f.seed.userId,
      f.sessionId,
      [review(f.cardIds[0], 0)],
      LATER,
    );
    expect(result?.applied).toBe(1);

    const [card] = await f.db
      .select()
      .from(schema.cards)
      .where(eq(schema.cards.id, f.cardIds[0]));
    expect(card.reps).toBe(1);
    expect(card.state).not.toBe(State.New);
    expect(card.due.getTime()).toBeGreaterThan(NOW.getTime());

    const [logged] = await f.db.select().from(schema.reviews);
    expect(logged.wasCorrect).toBe(true);
    expect(logged.answerGiven).toBe("answer 0");
    expect(logged.source).toBe("drill");
    expect(logged.stateBefore).toBe(State.New);
  });

  it("stores the raw signal, which is what makes the mapping reversible", async () => {
    await flushReviews(
      f.db,
      f.seed.userId,
      f.sessionId,
      [review(f.cardIds[0], 0, { wasCorrect: false, hintUsed: true, durationMs: 8123, answerGiven: "wrong" })],
      LATER,
    );
    const [logged] = await f.db.select().from(schema.reviews);
    expect(logged.wasCorrect).toBe(false);
    expect(logged.hintUsed).toBe(true);
    expect(logged.durationMs).toBe(8123);
    expect(logged.answerGiven).toBe("wrong");
    // And the derived value alongside it.
    expect(logged.rating).toBe(Rating.Again);
  });

  it("anchors reviewed_at on the server's session start, not the device clock", async () => {
    await flushReviews(
      f.db,
      f.seed.userId,
      f.sessionId,
      [review(f.cardIds[0], 0, { offsetMs: 12_000 })],
      LATER,
    );
    const [logged] = await f.db.select().from(schema.reviews);
    expect(logged.reviewedAt.toISOString()).toBe(new Date(NOW.getTime() + 12_000).toISOString());
  });

  it("never dates a review in the future, however large the offset", async () => {
    // A buffer flushed the next morning would otherwise claim a timestamp
    // ahead of the clock, and the card would be permanently not-due.
    await flushReviews(
      f.db,
      f.seed.userId,
      f.sessionId,
      [review(f.cardIds[0], 0, { offsetMs: 21_600_000 })],
      LATER,
    );
    const [logged] = await f.db.select().from(schema.reviews);
    expect(logged.reviewedAt.getTime()).toBeLessThanOrEqual(LATER.getTime());
  });

  it("rejects a session belonging to someone else", async () => {
    const other = await seedMinimal(f.db, { userId: "u_other", words: 1 });
    expect(
      await flushReviews(f.db, other.userId, f.sessionId, [review(f.cardIds[0], 0)], LATER),
    ).toBeNull();
    expect(await f.db.select().from(schema.reviews)).toHaveLength(0);
  });

  it("drops a review for a card the learner does not own, and keeps the rest", async () => {
    // One bad id must not cost the learner the other answers they gave.
    const result = await flushReviews(
      f.db,
      f.seed.userId,
      f.sessionId,
      [
        review("not-my-card", 0, { idempotencyKey: "k_bad" }),
        review(f.cardIds[0], 1),
      ],
      LATER,
    );
    expect(result?.applied).toBe(1);
    expect(await f.db.select().from(schema.reviews)).toHaveLength(1);
  });

  it("updates the study_sessions counters", async () => {
    await flushReviews(
      f.db,
      f.seed.userId,
      f.sessionId,
      [review(f.cardIds[0], 0), review(f.cardIds[1], 1, { idempotencyKey: "k_b" })],
      LATER,
    );
    const [session] = await f.db
      .select()
      .from(schema.studySessions)
      .where(eq(schema.studySessions.id, f.sessionId));
    expect(session.cardsDone).toBe(2);
    expect(session.endedAt).not.toBeNull();
  });

  it("accepts a flush with no session id", async () => {
    // The buffer survives a reload that lost the session id. Losing the
    // answers instead would be the worse trade.
    const result = await flushReviews(
      f.db,
      f.seed.userId,
      null,
      [review(f.cardIds[0], 0)],
      LATER,
    );
    expect(result?.applied).toBe(1);
  });
});

describe("idempotency", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await openSession(6);
  });

  afterEach(async () => {
    await closeDb(f.db);
  });

  function realBatch(f: Fixture): ReviewInput[] {
    return f.cardIds.slice(0, 3).map((cardId, index) => review(cardId, index));
  }

  it("double-flushing the same batch changes nothing at all", async () => {
    const first = await flushReviews(f.db, f.seed.userId, f.sessionId, realBatch(f), LATER);
    const after = await cardStates(f.db, f.seed.userId);

    const second = await flushReviews(f.db, f.seed.userId, f.sessionId, realBatch(f), LATER);
    const again = await cardStates(f.db, f.seed.userId);

    expect(first?.applied).toBe(3);
    expect(second?.applied).toBe(0);
    expect(second?.skipped).toBe(3);
    // Not "did not error" — did not move.
    expect(again).toEqual(after);
    expect(await f.db.select().from(schema.reviews)).toHaveLength(3);
  });

  it("a batch that repeats a key inside itself applies it once", async () => {
    const duplicated = [review(f.cardIds[0], 0), review(f.cardIds[0], 0)];
    const result = await flushReviews(f.db, f.seed.userId, f.sessionId, duplicated, LATER);
    expect(result?.applied).toBe(1);
    expect(result?.skipped).toBe(1);
    expect(await f.db.select().from(schema.reviews)).toHaveLength(1);
  });

  it("a partly-overlapping batch applies only the new part", async () => {
    await flushReviews(f.db, f.seed.userId, f.sessionId, realBatch(f), LATER);
    const overlapping = [
      ...realBatch(f),
      review(f.cardIds[3], 3),
    ];
    const result = await flushReviews(f.db, f.seed.userId, f.sessionId, overlapping, LATER);
    expect(result?.applied).toBe(1);
    expect(result?.skipped).toBe(3);
    expect(await f.db.select().from(schema.reviews)).toHaveLength(4);
  });

  it("does not update study_sessions twice for a repeated batch", async () => {
    await flushReviews(f.db, f.seed.userId, f.sessionId, realBatch(f), LATER);
    await flushReviews(f.db, f.seed.userId, f.sessionId, realBatch(f), LATER);
    const [session] = await f.db
      .select()
      .from(schema.studySessions)
      .where(eq(schema.studySessions.id, f.sessionId));
    expect(session.cardsDone).toBe(3);
  });

  it("does not double-count daily_activity for a repeated batch", async () => {
    await flushReviews(f.db, f.seed.userId, f.sessionId, realBatch(f), LATER);
    await flushReviews(f.db, f.seed.userId, f.sessionId, realBatch(f), LATER);
    const rows = await f.db.select().from(schema.dailyActivity);
    expect(rows).toHaveLength(1);
    expect(rows[0].cardsDone).toBe(3);
  });

  it("keys are distinct per attempt, so a re-queued wrong card counts twice", async () => {
    // Answering the same card twice inside one session is normal: a wrong
    // answer comes back within minutes. Those are two reviews, not a retry.
    const twice = [
      review(f.cardIds[0], 0, { idempotencyKey: `k_${f.cardIds[0]}_1`, wasCorrect: false, offsetMs: 5000 }),
      review(f.cardIds[0], 1, { idempotencyKey: `k_${f.cardIds[0]}_2`, wasCorrect: true, offsetMs: 90_000 }),
    ];
    const result = await flushReviews(f.db, f.seed.userId, f.sessionId, twice, LATER);
    expect(result?.applied).toBe(2);
    const [card] = await f.db.select().from(schema.cards).where(eq(schema.cards.id, f.cardIds[0]));
    expect(card.reps).toBe(2);
  });
});

describe("the replay invariant, through the real endpoint", () => {
  /**
   * PLAN.md §7.4: *"replaying a session's review log server-side yields the
   * same final card states regardless of how flushes were batched."*
   *
   * The pure version lives in `tests/unit/fsrs/replay.test.ts`. This one runs
   * the same log through the actual database path, because the invariant can
   * break in the wiring — a sort dropped, an update ordered wrong, a
   * transaction that commits per row — without the scheduler changing at all.
   */
  async function runLog(splits: number[]): Promise<unknown> {
    const f = await openSession(6);
    const log: ReviewInput[] = f.cardIds.slice(0, 3).flatMap((cardId, cardIndex) =>
      [0, 1, 2].map((attempt) => ({
        cardId,
        idempotencyKey: `k_${cardId}_${attempt}`,
        wasCorrect: (cardIndex + attempt) % 3 !== 0,
        durationMs: 2500 + attempt * 700,
        answerGiven: `a${attempt}`,
        hintUsed: attempt === 1,
        offsetMs: 4000 * (cardIndex * 3 + attempt) + 1000,
      })),
    );
    // Interleave so the batches genuinely straddle cards.
    log.sort((a, b) => a.offsetMs - b.offsetMs);

    let index = 0;
    for (const size of splits) {
      const slice = log.slice(index, index + size);
      index += size;
      if (slice.length > 0) await flushReviews(f.db, f.seed.userId, f.sessionId, slice, LATER);
    }
    if (index < log.length) {
      await flushReviews(f.db, f.seed.userId, f.sessionId, log.slice(index), LATER);
    }

    const states = await cardStates(f.db, f.seed.userId);
    await closeDb(f.db);
    return states;
  }

  it("one flush and nine flushes agree", async () => {
    const whole = await runLog([9]);
    for (const splits of [[1], [3, 3, 3], [5, 4], [8, 1], [2, 2, 2, 2, 1]]) {
      expect(await runLog(splits), `splits ${splits.join("+")}`).toEqual(whole);
    }
  }, 60_000);
});

describe("the columns the invariant depends on", () => {
  /**
   * **A test named for the failure it guards, because no test of correct
   * behaviour could have found this one.**
   *
   * The replay invariant failed on `real` columns. float4 keeps about seven
   * significant digits, so a stability written at a batch boundary comes back
   * rounded and the next review computes from a slightly different number:
   * 0.82816476 in one batch, 0.8281648 across two. Every unit test passed —
   * they never crossed a column — and the schedules differed by minutes on an
   * interval of weeks, which is invisible in the app and fatal to the
   * invariant.
   *
   * A JavaScript number is a float8, so `double precision` round-trips
   * exactly. This asserts the storage type rather than the behaviour, because
   * the behaviour is only wrong in the last two digits.
   */
  let db: TestDatabase;

  beforeEach(async () => {
    db = await migratedDb();
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("stores every FSRS float as double precision, never as real", async () => {
    const res = await db.$client.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and (table_name, column_name) in (
            ('cards','stability'), ('cards','difficulty'),
            ('reviews','stability_before'), ('reviews','difficulty_before'),
            ('reviews','stability_after'), ('reviews','difficulty_after'))
        order by table_name, column_name`,
    );
    expect(res.rows).toHaveLength(6);
    for (const row of res.rows) {
      expect(`${row.table_name}.${row.column_name} = ${row.data_type}`).toBe(
        `${row.table_name}.${row.column_name} = double precision`,
      );
    }
  });
});

describe("daily activity", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await openSession(6);
  });

  afterEach(async () => {
    await closeDb(f.db);
  });

  it("records cards and seconds for the day", async () => {
    await flushReviews(
      f.db,
      f.seed.userId,
      f.sessionId,
      [
        review(f.cardIds[0], 0, { durationMs: 4000 }),
        review(f.cardIds[1], 1, { idempotencyKey: "k_b", durationMs: 6000 }),
      ],
      LATER,
    );
    const [row] = await f.db.select().from(schema.dailyActivity);
    expect(row.cardsDone).toBe(2);
    expect(row.seconds).toBe(10);
  });

  it("accumulates across separate flushes in the same day", async () => {
    await flushReviews(f.db, f.seed.userId, f.sessionId, [review(f.cardIds[0], 0, { durationMs: 4000 })], LATER);
    await flushReviews(
      f.db,
      f.seed.userId,
      f.sessionId,
      [review(f.cardIds[1], 1, { idempotencyKey: "k_b", durationMs: 4000 })],
      LATER,
    );
    const rows = await f.db.select().from(schema.dailyActivity);
    expect(rows).toHaveLength(1);
    expect(rows[0].cardsDone).toBe(2);
    expect(rows[0].seconds).toBe(8);
  });

  it("reports the day's running totals back to the client", async () => {
    const result = await flushReviews(
      f.db,
      f.seed.userId,
      f.sessionId,
      [review(f.cardIds[0], 0, { durationMs: 5000 })],
      LATER,
    );
    expect(result?.today.cardsDone).toBe(1);
    expect(result?.today.seconds).toBe(5);
  });
});
