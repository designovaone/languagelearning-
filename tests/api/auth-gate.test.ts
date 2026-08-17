import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "@/lib/auth";
import * as schema from "@/lib/db/schema";
import { fixedClock } from "@/lib/time/clock";

import {
  closeDb,
  migratedDb,
  type TestDatabase,
} from "../db/helpers/pglite";

/**
 * PLAN.md §12, Layer 3: signup without a valid invite is refused, and a used
 * invite cannot be reused.
 *
 * This builds a real Better Auth instance over in-process Postgres, so it
 * exercises the actual hook wiring rather than a stand-in for it. No network,
 * no secrets, and a fixed clock so invite expiry is testable without waiting.
 */

const NOW = new Date("2026-08-17T12:00:00.000Z");
const PASSWORD = "correct-horse-battery";
const BASE_URL = "http://localhost:3000";

describe("invite-gated signup", () => {
  let db: TestDatabase;
  let auth: ReturnType<typeof createAuth>;

  beforeEach(async () => {
    db = await migratedDb();
    auth = createAuth(db, {
      clock: fixedClock(NOW),
      baseURL: BASE_URL,
      secret: "test-secret-not-used-outside-tests-0000000000",
    });
    await db.insert(schema.invites).values([
      { code: "GOOD-ONE" },
      { code: "USED-ONE", usedBy: null, usedAt: NOW },
      {
        code: "EXPIRED",
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      {
        code: "STILL-VALID",
        expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      },
    ]);
  });

  afterEach(async () => {
    await closeDb(db);
  });

  /**
   * Goes through `auth.handler`, the same entry point the Next route uses, so
   * this exercises the real request path including how a rejected invite turns
   * into an HTTP status. Calling `auth.api.signUpEmail` directly would skip
   * that conversion and test something production never runs.
   */
  async function signUp(email: string, body: Record<string, unknown> = {}) {
    return auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Test", email, password: PASSWORD, ...body }),
      }),
    );
  }

  async function userCount() {
    return (await db.select().from(schema.user)).length;
  }

  it("accepts a valid invite and creates exactly one user", async () => {
    const res = await signUp("a@example.test", { inviteCode: "GOOD-ONE" });
    expect(res.status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("refuses signup with no invite code at all", async () => {
    const res = await signUp("b@example.test");
    expect(res.status).toBe(403);
    expect(await userCount()).toBe(0);
  });

  it("refuses signup with an unknown invite code", async () => {
    const res = await signUp("c@example.test", { inviteCode: "NOPE" });
    expect(res.status).toBe(403);
    expect(await userCount()).toBe(0);
  });

  it("refuses signup with an already-used invite", async () => {
    const res = await signUp("d@example.test", { inviteCode: "USED-ONE" });
    expect(res.status).toBe(403);
    expect(await userCount()).toBe(0);
  });

  it("refuses signup with an expired invite", async () => {
    const res = await signUp("e@example.test", { inviteCode: "EXPIRED" });
    expect(res.status).toBe(403);
    expect(await userCount()).toBe(0);
  });

  it("accepts an invite that has not expired yet", async () => {
    const res = await signUp("f@example.test", { inviteCode: "STILL-VALID" });
    expect(res.status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("does not let the same invite be used twice", async () => {
    const first = await signUp("g@example.test", { inviteCode: "GOOD-ONE" });
    expect(first.status).toBe(200);

    const second = await signUp("h@example.test", { inviteCode: "GOOD-ONE" });
    expect(second.status).toBe(403);
    expect(await userCount()).toBe(1);
  });

  it("marks the invite used, with who used it and when", async () => {
    await signUp("i@example.test", { inviteCode: "GOOD-ONE" });
    const [invite] = await db
      .select()
      .from(schema.invites)
      .where(eq(schema.invites.code, "GOOD-ONE"));
    const [createdUser] = await db.select().from(schema.user);
    expect(invite.usedBy).toBe(createdUser.id);
    expect(invite.usedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("treats invite codes case-insensitively but not loosely", async () => {
    const res = await signUp("j@example.test", { inviteCode: " good-one " });
    expect(res.status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("gives the same message whether the code is unknown or already used", async () => {
    // Different messages would turn the endpoint into an oracle for guessing
    // which codes exist.
    const unknown = await signUp("k@example.test", { inviteCode: "NOPE" });
    const used = await signUp("l@example.test", { inviteCode: "USED-ONE" });
    expect(await unknown.clone().text()).toBe(await used.clone().text());
  });

  it("creates a profile row alongside the user", async () => {
    await signUp("m@example.test", {
      inviteCode: "GOOD-ONE",
      uiLocale: "de",
      baseLang: "de",
      timezone: "Europe/Berlin",
    });
    const [createdUser] = await db.select().from(schema.user);
    const [profile] = await db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, createdUser.id));

    expect(profile).toBeDefined();
    expect(profile.uiLocale).toBe("de");
    expect(profile.baseLang).toBe("de");
    expect(profile.timezone).toBe("Europe/Berlin");
    // The six extensibility columns must exist with sane defaults from day one.
    expect(profile.role).toBe("user");
    expect(profile.deletedAt).toBeNull();
    expect(profile.groupId).toBeNull();
  });

  it("never leaves a user without a profile", async () => {
    await signUp("n@example.test", { inviteCode: "GOOD-ONE" });
    const users = await db.select().from(schema.user);
    const rows = await db.select().from(schema.profiles);
    expect(rows).toHaveLength(users.length);
  });

  it("ignores an unrecognised locale rather than storing it", async () => {
    await signUp("o@example.test", {
      inviteCode: "GOOD-ONE",
      uiLocale: "klingon",
    });
    const [profile] = await db.select().from(schema.profiles);
    expect(profile.uiLocale).toBe("en");
  });
});
