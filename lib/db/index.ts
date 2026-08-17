import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";

import * as schema from "./schema";

/**
 * The database client.
 *
 * **Driver choice matters.** This uses `neon-serverless` (WebSocket), not
 * `neon-http`. The HTTP driver throws `No transactions support in neon-http
 * driver` on `db.transaction(...)`, and the review flush has to write `cards`
 * and `reviews` in one transaction (PLAN.md §7.4). Picking the HTTP driver
 * would have worked for every query in M1 and failed at M4.
 *
 * `getDb()` rather than a `db` constant, so importing this module never reads
 * the environment or opens a connection. That keeps it safe to import from
 * anywhere, including code a test pulls in transitively.
 *
 * Tests do not use this module at all. They build their own Drizzle instance
 * over PGlite with the same `schema`, so no test needs a DATABASE_URL or a
 * network.
 */

// Node 22 has a global WebSocket; the driver would find it anyway. Setting it
// explicitly makes the dependency visible instead of ambient.
if (typeof globalThis.WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = globalThis.WebSocket;
}

export type Database = NeonDatabase<typeof schema>;

let pool: Pool | undefined;
let database: Database | undefined;

export function getDb(): Database {
  if (!database) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.example to .env.local and paste " +
          "the Neon connection string (PLAN.md §13).",
      );
    }
    pool = new Pool({ connectionString });
    database = drizzle(pool, { schema });
  }
  return database;
}

/** Closes the pool. For scripts and tests; serverless functions never call it. */
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  database = undefined;
}

export { schema };
