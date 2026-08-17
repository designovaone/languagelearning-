import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  DIRECT_USER_TABLES,
  exportUserData,
  hardDeleteUser,
  INDIRECT_USER_TABLES,
  REFERENCE_ONLY_TABLES,
  softDeleteUser,
} from "@/lib/gdpr/export";

import { closeDb, migratedDb, type TestDatabase } from "./helpers/pglite";
import { seedMinimal, type Seed } from "./helpers/seed";

/**
 * GDPR Art. 15 and Art. 17 (PLAN.md §2, extensibility decision 4).
 *
 * The first test is the one that matters. An export that omits a table
 * produces a file that downloads fine, opens fine, and is wrong — there is no
 * error for anyone to notice, and no end-to-end test of a working program
 * would catch it, because the program *is* working. So the export's table list
 * is checked against the live schema instead of against a human's memory.
 */

const NOW = new Date("2026-08-17T12:00:00.000Z");

describe("data export covers the schema", () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await migratedDb();
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("accounts for every table that references a user", async () => {
    const res = await db.$client.query<{ table_name: string }>(
      `select distinct table_name from information_schema.columns
        where table_schema = 'public'
          and column_name in ('user_id', 'used_by', 'created_by')
        order by table_name`,
    );
    const referencing = res.rows.map((r) => r.table_name);
    expect(referencing.length).toBeGreaterThan(5);

    const accountedFor = new Set<string>([
      ...DIRECT_USER_TABLES,
      ...REFERENCE_ONLY_TABLES,
      // grammar_items.created_by records 'nightly' | 'manual', not a user.
      "grammar_items",
    ]);

    const forgotten = referencing.filter((t) => !accountedFor.has(t));
    expect(
      forgotten,
      "tables referencing a user but missing from lib/gdpr/export.ts",
    ).toEqual([]);
  });

  it("names every direct table in the export payload", async () => {
    const seed = await seedMinimal(db);
    const dump = await exportUserData(db, seed.userId, NOW);
    for (const table of DIRECT_USER_TABLES) {
      expect(Object.keys(dump.tables), `export missing ${table}`).toContain(
        table,
      );
    }
    for (const table of INDIRECT_USER_TABLES) {
      expect(Object.keys(dump.tables), `export missing ${table}`).toContain(
        table,
      );
    }
  });

  it("lists only tables that actually exist", async () => {
    const res = await db.$client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const real = new Set(res.rows.map((r) => r.table_name));
    const claimed = [
      ...DIRECT_USER_TABLES,
      ...INDIRECT_USER_TABLES,
      ...REFERENCE_ONLY_TABLES,
    ];
    expect(claimed.filter((t) => !real.has(t))).toEqual([]);
  });
});

describe("data export content", () => {
  let db: TestDatabase;
  let seed: Seed;

  beforeEach(async () => {
    db = await migratedDb();
    seed = await seedMinimal(db, { words: 2 });

    await db.insert(schema.cards).values({
      id: "card1",
      userId: seed.userId,
      courseId: seed.courseId,
      wordId: seed.wordIds[0],
      exerciseType: "recognition",
      due: NOW,
    });
    await db.insert(schema.reviews).values({
      id: "rev1",
      cardId: "card1",
      userId: seed.userId,
      wasCorrect: true,
      durationMs: 900,
      rating: 3,
      stateBefore: 0,
      stabilityBefore: 0,
      difficultyBefore: 0,
      dueBefore: NOW,
      stabilityAfter: 3,
      difficultyAfter: 5,
      scheduledDays: 3,
      elapsedDays: 0,
      reviewedAt: NOW,
      idempotencyKey: "idem-1",
    });
    await db.insert(schema.answerAnalysis).values({
      reviewId: "rev1",
      errorType: "wrong-auxiliary",
      model: "test-model",
    });
    await db.insert(schema.dailyActivity).values({
      userId: seed.userId,
      localDate: "2026-08-17",
      cardsDone: 1,
      seconds: 60,
    });
    await db.insert(schema.account).values({
      id: "acc1",
      accountId: seed.userId,
      providerId: "credential",
      userId: seed.userId,
      password: "hashed:super-secret",
      updatedAt: NOW,
    });
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("returns the learner's own rows", async () => {
    const dump = await exportUserData(db, seed.userId, NOW);
    expect(dump.userId).toBe(seed.userId);
    expect(dump.exportedAt).toBe(NOW.toISOString());
    expect(dump.tables.cards).toHaveLength(1);
    expect(dump.tables.reviews).toHaveLength(1);
    expect(dump.tables.daily_activity).toHaveLength(1);
    expect(dump.tables.profiles).toHaveLength(1);
  });

  it("reaches tables that have no user_id of their own", async () => {
    const dump = await exportUserData(db, seed.userId, NOW);
    expect(dump.tables.answer_analysis).toHaveLength(1);
  });

  it("never includes a password hash", async () => {
    // The export is handed to the user. Shipping the credential material with
    // it would be a data breach dressed as a feature.
    const dump = await exportUserData(db, seed.userId, NOW);
    const serialized = JSON.stringify(dump);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("hashed:");
    for (const row of dump.tables.account as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty("password");
    }
  });

  it("returns nothing for another learner's id", async () => {
    await seedMinimal(db, { userId: "u_other" });
    const dump = await exportUserData(db, "u_other", NOW);
    expect(dump.tables.cards).toHaveLength(0);
    expect(dump.tables.reviews).toHaveLength(0);
  });
});

describe("erasure", () => {
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
    await db.insert(schema.reviews).values({
      id: "rev1",
      cardId: "card1",
      userId: seed.userId,
      wasCorrect: true,
      durationMs: 900,
      rating: 3,
      stateBefore: 0,
      stabilityBefore: 0,
      difficultyBefore: 0,
      dueBefore: NOW,
      stabilityAfter: 3,
      difficultyAfter: 5,
      scheduledDays: 3,
      elapsedDays: 0,
      reviewedAt: NOW,
      idempotencyKey: "idem-1",
    });
    await db.insert(schema.answerAnalysis).values({
      reviewId: "rev1",
      errorType: "wrong-auxiliary",
      model: "test-model",
    });
    await db.insert(schema.invites).values({
      code: "USED-BY-THEM",
      usedBy: seed.userId,
      usedAt: NOW,
    });
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("hard delete leaves no row referencing the user anywhere", async () => {
    expect(await hardDeleteUser(db, seed.userId)).toBe(true);

    // Ask the database, not the code, whether anything survived.
    const res = await db.$client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and column_name = 'user_id'`,
    );
    const leftovers: string[] = [];
    for (const { table_name, column_name } of res.rows) {
      const count = await db.$client.query<{ n: number }>(
        `select count(*)::int as n from "${table_name}" where "${column_name}" = $1`,
        [seed.userId],
      );
      if (count.rows[0].n > 0) leftovers.push(table_name);
    }
    expect(leftovers).toEqual([]);
  });

  it("hard delete removes rows reached only through a review", async () => {
    await hardDeleteUser(db, seed.userId);
    expect(await db.select().from(schema.answerAnalysis)).toHaveLength(0);
  });

  it("keeps the invite row but drops the reference to the deleted user", async () => {
    // The invite is an audit record of who was let in, not the learner's data.
    // It must survive erasure without still naming them.
    await hardDeleteUser(db, seed.userId);
    const [invite] = await db.select().from(schema.invites);
    expect(invite).toBeDefined();
    expect(invite.usedBy).toBeNull();
  });

  it("leaves shared content untouched", async () => {
    await hardDeleteUser(db, seed.userId);
    expect(await db.select().from(schema.words)).toHaveLength(1);
    expect(await db.select().from(schema.courses)).toHaveLength(1);
  });

  it("reports false when there is nothing to delete", async () => {
    expect(await hardDeleteUser(db, "u_nobody")).toBe(false);
  });

  it("soft delete marks the profile without destroying history", async () => {
    expect(await softDeleteUser(db, seed.userId, NOW)).toBe(true);
    const [profile] = await db.select().from(schema.profiles);
    expect(profile.deletedAt?.toISOString()).toBe(NOW.toISOString());
    expect(await db.select().from(schema.reviews)).toHaveLength(1);
  });
});
