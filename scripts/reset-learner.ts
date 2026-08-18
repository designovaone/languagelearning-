/**
 * Return one learner to a pre-assessment state (PLAN.md §11, M3).
 *
 *   node --env-file=.env.local node_modules/.bin/tsx scripts/reset-learner.ts --email you@example.com
 *   ... --dry-run     count what would be deleted, delete nothing
 *
 * Local and admin-only by construction, the same shape as `reset-password.ts`:
 * it runs against the database from this machine and is reachable from nothing
 * the app exposes. The logic lives in `lib/learner/reset.ts` so it can be
 * tested against in-process Postgres; this file is the operator interface.
 */
import { createInterface } from "node:readline/promises";

import { eq } from "drizzle-orm";

import { closeDb, getDb } from "@/lib/db";
import { user } from "@/lib/db/auth-schema";
import { countProgress, resetLearner } from "@/lib/learner/reset";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run with --env-file=.env.local");
    return 2;
  }

  const email = arg("email");
  if (!email) {
    console.error("Usage: reset-learner.ts --email <address> [--dry-run]");
    return 2;
  }
  const dryRun = process.argv.includes("--dry-run");

  const db = getDb();
  const found = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.email, email));

  if (found.length === 0) {
    console.error(`No user with email ${email}.`);
    return 1;
  }
  const target = found[0];

  // Count first, always — including on a real run, so the operator sees what
  // is about to be destroyed before being asked to confirm rather than after.
  const counts = await countProgress(db, target.id);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  console.error(`\n${target.email} — rows that would be deleted:`);
  for (const [table, count] of Object.entries(counts)) {
    console.error(`  ${table.padEnd(18)} ${count}`);
  }
  console.error("  (profile, enrollment, push subscriptions and login are kept)\n");

  if (dryRun) {
    console.error("Dry run. Nothing deleted.");
    return 0;
  }
  if (total === 0) {
    console.error("Nothing to delete — this learner has no progress yet.");
    return 0;
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question("Type the email again to confirm deletion: ");
  rl.close();
  if (answer.trim() !== target.email) {
    console.error("Did not match. Nothing deleted.");
    return 1;
  }

  await resetLearner(db, target.id);
  console.error(`Reset ${target.email}. They can take the assessment again.`);
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
