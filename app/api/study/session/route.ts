import { requireApiUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { buildSession, needsAssessment } from "@/lib/study/session";
import { systemClock } from "@/lib/time/clock";

/**
 * The prefetch (PLAN.md §7.1).
 *
 * One request hands the device a whole session — the cards, the accepted
 * answers, and the learner's own pace baseline. After this returns, going from
 * one card to the next issues **zero network requests**. That is the exit
 * criterion for M4, and it is also the only way the "works in a dead spot"
 * claim can be true.
 *
 * A response with an empty `cards` array is not an error: it is "done for
 * today", and it still carries the day's numbers so the screen has something
 * to say.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET() {
  const { user, response } = await requireApiUser();
  if (response) return response;

  const db = getDb();

  // The page redirects; this is the same rule stated where a direct request
  // can also reach it. An ungated deck opens on function words (see
  // `needsAssessment`), so this is a content guarantee, not a formality.
  if (await needsAssessment(db, user.id)) {
    return Response.json({ error: "needs-assessment" }, { status: 409, headers: NO_STORE });
  }

  const session = await buildSession(db, user.id, systemClock.now());
  if (!session) {
    // No profile or no active enrollment. 409 rather than 404: the account
    // exists, it is just not in a state where a session means anything.
    return Response.json({ error: "no-course" }, { status: 409, headers: NO_STORE });
  }

  return Response.json(session, { headers: NO_STORE });
}
