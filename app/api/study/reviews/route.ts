import { z } from "zod";

import { requireApiUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { flushReviews } from "@/lib/study/session";
import { systemClock } from "@/lib/time/clock";

/**
 * The flush (PLAN.md §7.4).
 *
 * The device buffers answers and sends them in batches; every review carries
 * an idempotency key, so the same batch can arrive twice — a retry, a
 * `visibilitychange` racing the session end, a flaky connection — and change
 * nothing the second time.
 *
 * **The server runs FSRS. The client never does.** The device reports what
 * happened; what it means is decided here, once, from raw signal that is
 * stored alongside the verdict so the whole history can be replayed under a
 * different mapping later.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

const schema = z.object({
  sessionId: z.string().min(1).nullable().optional(),
  reviews: z
    .array(
      z.object({
        cardId: z.string().min(1),
        idempotencyKey: z.string().min(1).max(200),
        wasCorrect: z.boolean(),
        durationMs: z.number().int().min(0).max(600_000),
        answerGiven: z.string().max(500).nullable(),
        hintUsed: z.boolean(),
        offsetMs: z.number().int().min(0).max(21_600_000),
      }),
    )
    .min(1)
    // A session is ~60 cards; 200 leaves room for re-queued wrong answers and
    // for a buffer that never got flushed. Beyond that it is not a session.
    .max(200),
});

export async function POST(request: Request) {
  const { user, response } = await requireApiUser();
  if (response) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400, headers: NO_STORE });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "bad-request" }, { status: 400, headers: NO_STORE });
  }

  const result = await flushReviews(
    getDb(),
    user.id,
    parsed.data.sessionId ?? null,
    parsed.data.reviews,
    systemClock.now(),
  );
  if (!result) {
    return Response.json({ error: "not-found" }, { status: 404, headers: NO_STORE });
  }

  return Response.json(result, { headers: NO_STORE });
}
