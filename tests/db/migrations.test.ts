import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import {
  closeDb,
  freshDb,
  migratedDb,
  MIGRATIONS_FOLDER,
  tableNames,
} from "./helpers/pglite";

/** Every table PLAN.md §4 specifies, plus Better Auth's four. */
const EXPECTED_TABLES = [
  "account",
  "ai_calls",
  "answer_analysis",
  "assessment_items",
  "assessments",
  "audio_assets",
  "bands",
  "cards",
  "courses",
  "cron_runs",
  "daily_activity",
  "enrollments",
  "generated_content",
  "grammar_items",
  "invites",
  "nudge_log",
  "profiles",
  "push_subscriptions",
  "reviews",
  "sentences",
  "session",
  "streak_freezes",
  "study_sessions",
  "user",
  "verification",
  "words",
];

describe("migrations", () => {
  it("apply from empty", async () => {
    const db = await migratedDb();
    try {
      expect(await tableNames(db)).toEqual(EXPECTED_TABLES);
    } finally {
      await closeDb(db);
    }
  });

  it("applying twice is a no-op", async () => {
    const db = freshDb();
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const first = await tableNames(db);
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      expect(await tableNames(db)).toEqual(first);
    } finally {
      await closeDb(db);
    }
  });

  it("stores every timestamp as timestamptz", async () => {
    // PLAN.md §4: a timestamp stores an instant, never a wall-clock reading.
    // One `timestamp without time zone` would silently reintroduce the bug the
    // whole streak design is built to avoid.
    const db = await migratedDb();
    try {
      const res = await db.$client.query<{ loc: string }>(
        `select table_name || '.' || column_name as loc
           from information_schema.columns
          where table_schema = 'public'
            and data_type = 'timestamp without time zone'
          order by 1`,
      );
      expect(res.rows.map((r) => r.loc)).toEqual([]);
    } finally {
      await closeDb(db);
    }
  });

  it("keeps local_date as a plain date, not a timestamp", async () => {
    // A learner's study day is a calendar date in their zone. Storing it as an
    // instant would make it the server's day instead.
    const db = await migratedDb();
    try {
      const res = await db.$client.query<{
        table_name: string;
        data_type: string;
      }>(
        `select table_name, data_type from information_schema.columns
          where table_schema = 'public' and column_name = 'local_date'
          order by table_name`,
      );
      expect(res.rows.length).toBeGreaterThan(0);
      for (const row of res.rows) expect(row.data_type).toBe("date");
    } finally {
      await closeDb(db);
    }
  });

  it("carries source and license on every content table", async () => {
    // A missing attribution is a licence breach (PLAN.md §4), so the schema
    // must make one impossible rather than the loader remembering to check.
    const contentTables = ["courses", "words", "sentences", "audio_assets"];
    const db = await migratedDb();
    try {
      for (const table of contentTables) {
        const res = await db.$client.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = $1
              and column_name in ('source', 'license')`,
          [table],
        );
        const cols = res.rows.map((r) => r.column_name).sort();
        // audio_assets carries source only; the licence is the model's, recorded
        // once in the attribution file rather than per row.
        const expected =
          table === "audio_assets" ? ["source"] : ["license", "source"];
        expect(cols, `${table} attribution columns`).toEqual(expected);
      }
    } finally {
      await closeDb(db);
    }
  });

  it("makes every content table NOT NULL on source", async () => {
    const db = await migratedDb();
    try {
      const res = await db.$client.query<{
        table_name: string;
        is_nullable: string;
      }>(
        `select table_name, is_nullable from information_schema.columns
          where table_schema = 'public' and column_name = 'source'
            and table_name <> 'reviews'
          order by table_name`,
      );
      expect(res.rows.length).toBeGreaterThan(0);
      for (const row of res.rows) {
        expect(row.is_nullable, `${row.table_name}.source`).toBe("NO");
      }
    } finally {
      await closeDb(db);
    }
  });
});
