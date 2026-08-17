import { and, eq, isNull, or, sql } from "drizzle-orm";

import { invites } from "@/lib/db/schema";

/**
 * The invite gate (PLAN.md §2).
 *
 * A public URL with open registration is an abuse surface, so signup requires
 * a code that an admin issued. These functions take `db` and `now` rather than
 * reaching for either, which is what lets the whole gate be tested against
 * in-process Postgres with no network and no wall clock.
 */

export type InviteRejection =
  | "missing"
  | "unknown"
  | "already-used"
  | "expired";

export class InviteError extends Error {
  constructor(readonly reason: InviteRejection) {
    super(`Invite rejected: ${reason}`);
    this.name = "InviteError";
  }
}

export function normalizeCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

/**
 * Throws `InviteError` unless `code` is a real, unused, unexpired invite.
 * Read-only: consuming happens after the user row exists.
 */
export async function assertInviteValid(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  rawCode: unknown,
  now: Date,
): Promise<void> {
  const code = normalizeCode(rawCode);
  if (!code) throw new InviteError("missing");

  const rows = await db
    .select()
    .from(invites)
    .where(eq(invites.code, code))
    .limit(1);

  const invite = rows[0];
  if (!invite) throw new InviteError("unknown");
  if (invite.usedBy || invite.usedAt) throw new InviteError("already-used");
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) {
    throw new InviteError("expired");
  }
}

/**
 * Marks the invite used, atomically.
 *
 * The `usedBy is null` guard is the whole point: two people racing the same
 * code both pass `assertInviteValid`, and exactly one wins here. Returns false
 * if the caller lost the race.
 */
export async function consumeInvite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  rawCode: unknown,
  userId: string,
  now: Date,
): Promise<boolean> {
  const code = normalizeCode(rawCode);
  if (!code) return false;

  const updated = await db
    .update(invites)
    .set({ usedBy: userId, usedAt: now })
    .where(
      and(
        eq(invites.code, code),
        isNull(invites.usedBy),
        isNull(invites.usedAt),
        or(isNull(invites.expiresAt), sql`${invites.expiresAt} > ${now}`),
      ),
    )
    .returning({ code: invites.code });

  return updated.length === 1;
}
