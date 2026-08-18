import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { needsAssessment } from "@/lib/study/session";

import { StudyRunner } from "./study-runner";

/**
 * The drill (PLAN.md §7).
 *
 * The page is a shell: it proves the session gate and renders the runner,
 * which fetches one prefetch and then works entirely on the device. Server-
 * rendering the first card would save one round trip and cost the property
 * the whole design rests on — that card-to-card transitions touch no network.
 *
 * **An unassessed learner is sent to the assessment instead.** Without a
 * sitting the deck is ordered by raw frequency, and the drill opens on `e`,
 * `di`, `il`, `la` — function words whose cards teach nothing and whose
 * translations are the worst in the deck. See `needsAssessment`.
 */
export default async function StudyPage() {
  const user = await requireUser("/study");
  if (await needsAssessment(getDb(), user.id)) redirect("/assessment");
  const t = await getTranslations();

  return (
    <main className="flex flex-col gap-6">
      <h1 className="sr-only">{t("nav.study")}</h1>
      <StudyRunner />
    </main>
  );
}
