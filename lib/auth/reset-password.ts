import type { Auth } from "@/lib/auth";

/**
 * Password reset without an email provider (PLAN.md §13).
 *
 * "Manual" has to mean an actual mechanism, not editing rows by hand. This
 * hashes with Better Auth's own hasher and writes through its internal
 * adapter, so a reset password is indistinguishable from one set at signup.
 *
 * Admin-only by construction: it never touches the deployed app, and
 * `scripts/reset-password.ts` runs it locally against the database.
 */

export type ResetOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: "unknown-email" | "password-too-short" };

export const MIN_PASSWORD_LENGTH = 12;

export async function resetPassword(
  auth: Auth,
  email: string,
  newPassword: string,
): Promise<ResetOutcome> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: "password-too-short" };
  }

  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(
    email.trim().toLowerCase(),
  );
  if (!existing?.user) return { ok: false, reason: "unknown-email" };

  const hash = await ctx.password.hash(newPassword);
  await ctx.internalAdapter.updatePassword(existing.user.id, hash);

  return { ok: true, userId: existing.user.id };
}
