import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Proves Layer 2 of the test plan is viable before anything depends on it:
 * real Postgres, in-process, no Docker and no network, so it runs in CI on a
 * public repo (PLAN.md §12).
 *
 * Timezone behaviour lives in `activity.tz.test.ts`, which also runs under
 * three server timezones via `npm run test:tz`.
 */
describe("pglite harness", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create table probe (
        id serial primary key,
        label text not null,
        at timestamptz not null
      );
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  it("runs DDL and DML against real Postgres", async () => {
    await db.exec(`
      insert into probe (label, at) values
        ('a', timestamptz '2026-08-17 12:00:00+00'),
        ('b', timestamptz '2026-08-18 12:00:00+00');
    `);
    const res = await db.query<{ count: string }>(
      `select count(*)::text as count from probe`,
    );
    expect(res.rows[0].count).toBe("2");
  });

  it("enforces constraints rather than silently accepting bad rows", async () => {
    await expect(
      db.exec(`insert into probe (label, at) values (null, now())`),
    ).rejects.toThrow(/not-null|null value/i);
  });

  it("keeps timestamptz identical regardless of the client's TZ", async () => {
    // Postgres stores an instant, not a wall-clock reading. Everything in the
    // schema is timestamptz for this reason (PLAN.md §4).
    const res = await db.query<{ iso: string }>(
      `select to_char(timestamptz '2026-08-17 12:00:00+00' at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS"Z"') as iso
       from probe limit 1`,
    );
    expect(res.rows[0].iso).toBe("2026-08-17T12:00:00Z");
  });
});
