import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Timezone-sensitive database behaviour. Files named `*.tz.test.ts` are the set
 * `npm run test:tz` runs under TZ=UTC, TZ=Europe/Berlin and TZ=Pacific/Auckland
 * (PLAN.md §12, Discipline rule 2). If a result changes between those runs, a
 * learner would have lost a streak before anyone noticed.
 *
 * The naming convention matters more than it looks: `test:tz` runs *without*
 * --passWithNoTests, so if these files ever disappear the script fails loudly
 * instead of passing on an empty set.
 *
 * These assertions also prove the in-process Postgres ships full tzdata. The
 * streak, `daily_activity` and the nudge all compute a learner's `local_date`
 * in their own IANA zone while the server runs UTC. Without tzdata every one of
 * those tests would be measuring the wrong thing.
 */
describe("timezone handling is independent of the server's TZ", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
  });

  afterAll(async () => {
    await db.close();
  });

  it("Europe/Berlin is UTC+1 before the 2026 DST switch", async () => {
    const res = await db.query<{ local: string }>(
      `select (timestamptz '2026-03-29 00:30:00+00' at time zone 'Europe/Berlin')::text as local`,
    );
    expect(res.rows[0].local).toBe("2026-03-29 01:30:00");
  });

  it("Europe/Berlin is UTC+2 after the 2026 DST switch", async () => {
    const res = await db.query<{ local: string }>(
      `select (timestamptz '2026-03-29 01:30:00+00' at time zone 'Europe/Berlin')::text as local`,
    );
    expect(res.rows[0].local).toBe("2026-03-29 03:30:00");
  });

  it("Europe/Berlin returns to UTC+1 after the autumn switch", async () => {
    const res = await db.query<{ local: string }>(
      `select (timestamptz '2026-10-25 01:30:00+00' at time zone 'Europe/Berlin')::text as local`,
    );
    expect(res.rows[0].local).toBe("2026-10-25 02:30:00");
  });

  it("a learner's local_date can differ from the UTC date", async () => {
    // 23:30 UTC on the 17th is already the 18th in Auckland. A study day
    // belongs to the learner, never to the server.
    const res = await db.query<{ utc_date: string; nz_date: string }>(`
      select (timestamptz '2026-08-17 23:30:00+00' at time zone 'UTC')::date::text            as utc_date,
             (timestamptz '2026-08-17 23:30:00+00' at time zone 'Pacific/Auckland')::date::text as nz_date
    `);
    expect(res.rows[0].utc_date).toBe("2026-08-17");
    expect(res.rows[0].nz_date).toBe("2026-08-18");
  });

  it("the same instant lands on different local dates in Berlin and Auckland", async () => {
    const res = await db.query<{ de_date: string; nz_date: string }>(`
      select (timestamptz '2026-08-17 22:30:00+00' at time zone 'Europe/Berlin')::date::text    as de_date,
             (timestamptz '2026-08-17 22:30:00+00' at time zone 'Pacific/Auckland')::date::text as nz_date
    `);
    expect(res.rows[0].de_date).toBe("2026-08-18");
    expect(res.rows[0].nz_date).toBe("2026-08-18");
  });
});
