/**
 * Manual password reset (PLAN.md §13).
 *
 * There is no email provider in the first phase, so there is no self-service
 * reset. This runs locally against the database and never touches the deployed
 * app, which is what makes it admin-only by construction.
 *
 *   npx tsx scripts/reset-password.ts someone@example.com
 *
 * The password is read from stdin rather than argv, so it does not land in the
 * shell history or in `ps` output.
 */
import { createInterface } from "node:readline/promises";

import { getAuth } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH, resetPassword } from "@/lib/auth/reset-password";
import { closeDb } from "@/lib/db";

async function main(): Promise<number> {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx tsx scripts/reset-password.ts <email>");
    return 2;
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. Run with: node --env-file=.env.local ...",
    );
    return 2;
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const password = await rl.question(
    `New password for ${email} (min ${MIN_PASSWORD_LENGTH} chars): `,
  );
  const again = await rl.question("Repeat it: ");
  rl.close();

  if (password !== again) {
    console.error("Passwords did not match. Nothing changed.");
    return 1;
  }

  const result = await resetPassword(getAuth(), email, password);

  if (!result.ok) {
    const message =
      result.reason === "unknown-email"
        ? `No account with that email: ${email}`
        : `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    console.error(message);
    return 1;
  }

  console.error(`Password updated for ${email} (user ${result.userId}).`);
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
