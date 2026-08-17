import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import * as schema from "@/lib/db/schema";

export const MIGRATIONS_FOLDER = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "lib",
  "db",
  "migrations",
);

export type TestDatabase = PgliteDatabase<typeof schema> & { $client: PGlite };

/**
 * A fresh, empty in-process Postgres. Real Postgres 18, no Docker, no network,
 * so this runs in CI on a public repo (PLAN.md §12, Layer 2).
 */
export function freshDb(): TestDatabase {
  const client = new PGlite();
  return drizzle(client, { schema }) as TestDatabase;
}

/** A fresh database with every checked-in migration applied. */
export async function migratedDb(): Promise<TestDatabase> {
  const db = freshDb();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

export async function closeDb(db: TestDatabase): Promise<void> {
  await db.$client.close();
}

/** Table names present in the public schema, sorted. */
export async function tableNames(db: TestDatabase): Promise<string[]> {
  const res = await db.$client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`,
  );
  return res.rows.map((r) => r.table_name);
}

/**
 * The text of a rejection, including its `cause` chain.
 *
 * Drizzle wraps a failing query as `Failed query: …` and hangs the real
 * Postgres error (`duplicate key`, `violates check constraint`) off `cause`.
 * Asserting on the top-level message alone would pass for *any* failure, which
 * would make a constraint test green whether or not the constraint exists.
 *
 * Returns "" when the promise resolves, so an assertion on the text also
 * asserts that it rejected at all.
 */
export async function rejectionText(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return parts.join(" | ");
  }
}
