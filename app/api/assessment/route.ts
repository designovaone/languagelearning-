import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { courseFor, startAssessment, submitAssessment } from "@/lib/assessment/service";
import { requireApiUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { systemClock } from "@/lib/time/clock";

/**
 * The assessment endpoint (PLAN.md §6).
 *
 * `POST` with no body starts a sitting and returns the prompts. `POST` with
 * answers finishes it. Two verbs on one route because they are two halves of
 * one transaction from the learner's point of view.
 *
 * **Which prompts are traps is never sent to the client.** The items are
 * written to the database before the learner sees them and read back by index
 * on submit. Sending `isReal` down and trusting it back would put the
 * false-alarm rate — the one measurement that makes self-report trustworthy —
 * under the control of the thing being measured.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

const submitSchema = z.object({
  assessmentId: z.string().min(1),
  answers: z
    .array(
      z.object({
        index: z.number().int().min(0),
        answeredKnown: z.boolean(),
        durationMs: z.number().int().min(0).max(600_000).optional(),
      }),
    )
    .min(1)
    .max(200),
});

/** Course slug → the pseudoword pool built by `pipeline/stages/20_pseudowords.py`. */
const POOL_FOR: Record<string, string> = {
  "it-from-en": "it-20-pseudowords.jsonl",
  "en-from-de": "en-20-pseudowords.jsonl",
};

let poolCache: Record<string, string[]> = {};

function pseudowordsFor(courseSlug: string): string[] {
  if (poolCache[courseSlug]) return poolCache[courseSlug];
  const file = POOL_FOR[courseSlug];
  if (!file) return [];
  const path = join(process.cwd(), "pipeline", "artifacts", file);
  const forms = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => (JSON.parse(line) as { form: string }).form);
  poolCache = { ...poolCache, [courseSlug]: forms };
  return forms;
}

export async function POST(request: Request) {
  const { user, response } = await requireApiUser();
  if (response) return response;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  // --- finish a sitting -----------------------------------------------------
  if (body && typeof body === "object" && "assessmentId" in body) {
    const parsed = submitSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "bad-request" }, { status: 400, headers: NO_STORE });
    }
    const result = await submitAssessment(
      getDb(),
      user.id,
      parsed.data.assessmentId,
      parsed.data.answers,
      systemClock.now(),
    );
    if (!result) {
      return Response.json({ error: "not-found" }, { status: 404, headers: NO_STORE });
    }
    return Response.json(result, { headers: NO_STORE });
  }

  // --- start a sitting ------------------------------------------------------
  // Look the course up directly. Starting a throwaway sitting to read its slug
  // would write an orphan `assessments` row on every start, and an orphan
  // counts as a sitting everywhere that asks "has this learner been assessed".
  const db = getDb();
  const course = await courseFor(db, user.id);
  if (!course) {
    return Response.json({ error: "no-course" }, { status: 409, headers: NO_STORE });
  }
  const pool = pseudowordsFor(course.slug);
  if (pool.length === 0) {
    return Response.json({ error: "no-pseudowords" }, { status: 500, headers: NO_STORE });
  }
  const started = await startAssessment(db, user.id, pool, systemClock.now());
  if (!started) {
    return Response.json({ error: "no-course" }, { status: 409, headers: NO_STORE });
  }

  return Response.json(
    { assessmentId: started.assessmentId, items: started.items },
    { headers: NO_STORE },
  );
}
