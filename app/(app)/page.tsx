import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireUser } from "@/lib/auth/session";

/**
 * The dashboard. M1 ships the shell and the session gate; the streak, due
 * count and staleness warning arrive with M4 and M7.
 */
export default async function DashboardPage() {
  const user = await requireUser();
  const t = await getTranslations();

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("app.name")}
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {t("app.tagline")}
        </p>
      </header>

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t("dashboard.dueToday")}
        </p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">—</p>
        <Link
          href="/study"
          className="mt-4 block rounded-lg bg-neutral-900 px-4 py-3 text-center font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          {t("dashboard.startSession")}
        </Link>
      </section>

      <nav className="flex gap-4 text-sm">
        <Link href="/settings" className="underline">
          {t("nav.settings")}
        </Link>
      </nav>

      <p className="text-xs text-neutral-500">{user.email}</p>
    </main>
  );
}
