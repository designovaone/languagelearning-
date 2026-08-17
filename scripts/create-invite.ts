/**
 * Issue an invite code (PLAN.md §2 — signup is invite-gated).
 *
 * Runs locally against the database, never through the deployed app, so it is
 * admin-only by construction — the same shape as `reset-password.ts`.
 *
 *   node --env-file=.env.local node_modules/.bin/tsx scripts/create-invite.ts [--days 30]
 */
import { randomBytes } from "node:crypto";

import { closeDb, getDb } from "@/lib/db";
import { invites } from "@/lib/db/schema";
import { systemClock } from "@/lib/time/clock";

/** Unambiguous alphabet: no O/0, no I/1/L. These get read aloud and retyped. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars
    .slice(8, 12)
    .join("")}`;
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run with --env-file=.env.local");
    return 2;
  }

  const daysIndex = process.argv.indexOf("--days");
  const days = daysIndex >= 0 ? Number(process.argv[daysIndex + 1]) : 30;
  if (!Number.isFinite(days) || days <= 0) {
    console.error("--days must be a positive number");
    return 2;
  }

  const now = systemClock.now();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const code = generateCode();

  await getDb().insert(invites).values({ code, expiresAt });

  console.error(`Invite created, valid for ${days} days (until ${expiresAt.toISOString()}).`);
  console.log(code);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
