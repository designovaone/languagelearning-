import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "@/lib/auth";
import { resetPassword } from "@/lib/auth/reset-password";
import * as schema from "@/lib/db/schema";
import { fixedClock } from "@/lib/time/clock";

import { closeDb, migratedDb, type TestDatabase } from "../db/helpers/pglite";

/**
 * PLAN.md §11 M1 exit: "the reset script works end to end".
 *
 * End to end means the reset produces a password that actually signs in and
 * retires the old one — not that the function returned `{ ok: true }`. A reset
 * that writes a hash the verifier cannot read would pass a shallower test and
 * lock the learner out, which is exactly the failure nobody gets an error
 * message about until they try to log in.
 */

const NOW = new Date("2026-08-17T12:00:00.000Z");
const BASE_URL = "http://localhost:3000";
const OLD_PASSWORD = "original-password-1";
const NEW_PASSWORD = "replacement-password-2";
const EMAIL = "learner@example.test";

describe("manual password reset", () => {
  let db: TestDatabase;
  let auth: ReturnType<typeof createAuth>;

  beforeEach(async () => {
    db = await migratedDb();
    auth = createAuth(db, {
      clock: fixedClock(NOW),
      baseURL: BASE_URL,
      secret: "test-secret-not-used-outside-tests-0000000000",
    });
    await db.insert(schema.invites).values({ code: "GOOD-ONE" });

    const res = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          email: EMAIL,
          password: OLD_PASSWORD,
          inviteCode: "GOOD-ONE",
        }),
      }),
    );
    expect(res.status).toBe(200);
  });

  afterEach(async () => {
    await closeDb(db);
  });

  async function signIn(password: string) {
    return auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password }),
      }),
    );
  }

  it("signs in with the original password before any reset", async () => {
    // Guards the test itself: if this failed, everything below would be
    // measuring nothing.
    expect((await signIn(OLD_PASSWORD)).status).toBe(200);
  });

  it("lets the learner sign in with the new password", async () => {
    const result = await resetPassword(auth, EMAIL, NEW_PASSWORD);
    expect(result.ok).toBe(true);
    expect((await signIn(NEW_PASSWORD)).status).toBe(200);
  });

  it("stops the old password working", async () => {
    await resetPassword(auth, EMAIL, NEW_PASSWORD);
    expect((await signIn(OLD_PASSWORD)).status).not.toBe(200);
  });

  it("is case-insensitive about the email", async () => {
    const result = await resetPassword(auth, "  LEARNER@Example.TEST ", NEW_PASSWORD);
    expect(result.ok).toBe(true);
    expect((await signIn(NEW_PASSWORD)).status).toBe(200);
  });

  it("refuses an unknown email without changing anything", async () => {
    const result = await resetPassword(auth, "nobody@example.test", NEW_PASSWORD);
    expect(result).toEqual({ ok: false, reason: "unknown-email" });
    expect((await signIn(OLD_PASSWORD)).status).toBe(200);
  });

  it("refuses a short password without changing anything", async () => {
    const result = await resetPassword(auth, EMAIL, "short");
    expect(result).toEqual({ ok: false, reason: "password-too-short" });
    expect((await signIn(OLD_PASSWORD)).status).toBe(200);
  });

  it("can be run twice, and only the latest password works", async () => {
    await resetPassword(auth, EMAIL, NEW_PASSWORD);
    await resetPassword(auth, EMAIL, "third-password-here-3");
    expect((await signIn("third-password-here-3")).status).toBe(200);
    expect((await signIn(NEW_PASSWORD)).status).not.toBe(200);
  });

  it("leaves the account row intact apart from the password", async () => {
    const before = await db.select().from(schema.account);
    await resetPassword(auth, EMAIL, NEW_PASSWORD);
    const after = await db.select().from(schema.account);
    expect(after).toHaveLength(before.length);
    expect(after[0].userId).toBe(before[0].userId);
    expect(after[0].providerId).toBe(before[0].providerId);
    expect(after[0].password).not.toBe(before[0].password);
  });
});
