import { and, asc, eq, lte } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

import {
  closeDb,
  migratedDb,
  rejectionText,
  type TestDatabase,
} from "./helpers/pglite";
import { seedMinimal, type Seed } from "./helpers/seed";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const YESTERDAY = new Date("2026-08-16T12:00:00.000Z");
const NEXT_WEEK = new Date("2026-08-24T12:00:00.000Z");

describe("cards table", () => {
  let db: TestDatabase;
  let seed: Seed;

  beforeEach(async () => {
    db = await migratedDb();
    seed = await seedMinimal(db, { words: 3 });
  });

  afterEach(async () => {
    await closeDb(db);
  });

  let cardCounter = 0;

  function card(overrides: Partial<typeof schema.cards.$inferInsert> = {}) {
    return {
      id: `card_${++cardCounter}`,
      userId: seed.userId,
      courseId: seed.courseId,
      wordId: seed.wordIds[0],
      exerciseType: "recognition",
      due: NOW,
      ...overrides,
    } satisfies typeof schema.cards.$inferInsert;
  }

  it("enforces one FSRS state per (user, word, exercise type)", async () => {
    await db.insert(schema.cards).values(card());
    expect(await rejectionText(db.insert(schema.cards).values(card()))).toMatch(
      /duplicate key|unique/i,
    );
  });

  it("allows the same word at a different exercise type", async () => {
    // Recognition, production and listening are different skills, so they get
    // independent FSRS state (PLAN.md §2).
    await db.insert(schema.cards).values(card({ exerciseType: "recognition" }));
    await db.insert(schema.cards).values(card({ exerciseType: "production" }));
    await db.insert(schema.cards).values(card({ exerciseType: "listening" }));
    const rows = await db
      .select()
      .from(schema.cards)
      .where(eq(schema.cards.wordId, seed.wordIds[0]));
    expect(rows).toHaveLength(3);
  });

  it("rejects a card with neither a word nor a grammar item", async () => {
    expect(await rejectionText(
      db.insert(schema.cards).values(card({ wordId: null })),
    )).toMatch(/cards_exactly_one_target|violates check/i);
  });

  it("rejects a card with both a word and a grammar item", async () => {
    await db.insert(schema.grammarItems).values({
      id: "g1",
      courseId: seed.courseId,
      title: "Essere vs avere",
      explanation: { en: "..." },
      examples: [],
    });
    expect(await rejectionText(
      db.insert(schema.cards).values(card({ grammarItemId: "g1" })),
    )).toMatch(/cards_exactly_one_target|violates check/i);
  });

  it("accepts a grammar card with no word — FSRS schedules more than words", async () => {
    await db.insert(schema.grammarItems).values({
      id: "g1",
      courseId: seed.courseId,
      title: "Essere vs avere",
      explanation: { en: "..." },
      examples: [],
    });
    await db
      .insert(schema.cards)
      .values(card({ wordId: null, grammarItemId: "g1", exerciseType: "grammar" }));
    const rows = await db.select().from(schema.cards);
    expect(rows).toHaveLength(1);
    expect(rows[0].grammarItemId).toBe("g1");
  });

  it("rejects an out-of-range FSRS state", async () => {
    expect(await rejectionText(
      db.insert(schema.cards).values(card({ state: 7 })),
    )).toMatch(/cards_state_range|violates check/i);
  });

  it("returns only due, unsuspended cards for the hot query", async () => {
    await db.insert(schema.cards).values([
      card({ wordId: seed.wordIds[0], due: YESTERDAY }),
      card({ wordId: seed.wordIds[1], due: NEXT_WEEK }),
      card({ wordId: seed.wordIds[2], due: YESTERDAY, suspended: true }),
    ]);

    const due = await db
      .select()
      .from(schema.cards)
      .where(
        and(
          eq(schema.cards.userId, seed.userId),
          lte(schema.cards.due, NOW),
          eq(schema.cards.suspended, false),
        ),
      )
      .orderBy(asc(schema.cards.due));

    expect(due.map((c) => c.wordId)).toEqual([seed.wordIds[0]]);
  });

  it("uses the partial index for the due-card query", async () => {
    // The index is the whole reason the queue build is cheap. If a schema edit
    // drops the WHERE clause, the index silently stops matching and the query
    // still returns the right answer — just slowly, with no error anywhere.
    await db.$client.query(`set enable_seqscan = off`);
    const plan = await db.$client.query<{ "QUERY PLAN": string }>(
      `explain select * from cards
        where user_id = $1 and due <= $2 and suspended = false
        order by due asc`,
      [seed.userId, NOW.toISOString()],
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toContain("cards_user_due_idx");
  });

  it("cascades card deletion when the user is deleted", async () => {
    await db.insert(schema.cards).values(card());
    await db.delete(schema.user).where(eq(schema.user.id, seed.userId));
    expect(await db.select().from(schema.cards)).toHaveLength(0);
  });
});

describe("reviews table", () => {
  let db: TestDatabase;
  let seed: Seed;

  beforeEach(async () => {
    db = await migratedDb();
    seed = await seedMinimal(db, { words: 1 });
    await db.insert(schema.cards).values({
      id: "card1",
      userId: seed.userId,
      courseId: seed.courseId,
      wordId: seed.wordIds[0],
      exerciseType: "recognition",
      due: NOW,
    });
  });

  afterEach(async () => {
    await closeDb(db);
  });

  function review(key: string) {
    return {
      id: `r_${key}`,
      cardId: "card1",
      userId: seed.userId,
      wasCorrect: true,
      durationMs: 1200,
      rating: 3,
      stateBefore: 0,
      stabilityBefore: 0,
      difficultyBefore: 0,
      dueBefore: NOW,
      stabilityAfter: 3.2,
      difficultyAfter: 5.1,
      scheduledDays: 3,
      elapsedDays: 0,
      reviewedAt: NOW,
      idempotencyKey: key,
    } satisfies typeof schema.reviews.$inferInsert;
  }

  it("refuses a repeated idempotency key", async () => {
    // A flush that arrives twice must write once (PLAN.md §7.4).
    await db.insert(schema.reviews).values(review("k1"));
    expect(await rejectionText(
      db.insert(schema.reviews).values({ ...review("k1"), id: "r_other" }),
    )).toMatch(/duplicate key|unique/i);
    expect(await db.select().from(schema.reviews)).toHaveLength(1);
  });

  it("rejects an out-of-range rating", async () => {
    expect(await rejectionText(
      db.insert(schema.reviews).values({ ...review("k2"), rating: 9 }),
    )).toMatch(/reviews_rating_range|violates check/i);
  });

  it("keeps the raw signal alongside the derived grade", async () => {
    // The grade mapping is only reversible because the raw signal is stored
    // (PLAN.md §7.3). Losing a column here turns a re-run into a rewrite.
    await db.insert(schema.reviews).values({
      ...review("k3"),
      wasCorrect: false,
      durationMs: 9000,
      answerGiven: "sono andato",
      hintUsed: true,
      rating: 1,
    });
    const [row] = await db.select().from(schema.reviews);
    expect(row.wasCorrect).toBe(false);
    expect(row.durationMs).toBe(9000);
    expect(row.answerGiven).toBe("sono andato");
    expect(row.hintUsed).toBe(true);
  });
});
