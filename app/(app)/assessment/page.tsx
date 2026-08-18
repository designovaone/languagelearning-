import { getTranslations } from "next-intl/server";

import { AssessmentRunner } from "./assessment-runner";

/**
 * The assessment (PLAN.md §6). Gated by the (app) layout, like every page here.
 *
 * The work happens client-side after one request, for the same reason the drill
 * will: a card that waits on the network between taps feels broken, and this
 * screen is the first thing a new learner ever does.
 */
export default async function AssessmentPage() {
  const t = await getTranslations("assessment");
  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{t("intro")}</p>
      </header>
      <AssessmentRunner />
    </main>
  );
}
