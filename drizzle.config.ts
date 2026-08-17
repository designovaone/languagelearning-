import { defineConfig } from "drizzle-kit";

/**
 * Migrations are checked in (PLAN.md §11, M1) and applied from empty in tests
 * against PGlite, so `db/migrations.test.ts` proves them without a network.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
