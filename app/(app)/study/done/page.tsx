import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { dayStatus } from "@/lib/study/session";
import { systemClock } from "@/lib/time/clock";

/**
 * "Done for today", server-rendered (PLAN.md §7.2).
 *
 * The same screen the drill shows when the queue comes back empty, reachable
 * on its own and working without JavaScript. It exists as a route because it
 * is a destination rather than a state: it is where the dashboard sends
 * someone who has nothing due, and it is the screen that carries the argument
 * of this whole project — the app tells you to stop, and means it.
 *
 * If cards *are* due it does not pretend otherwise; it offers the drill.
 */
export default async function DonePage() {
  const user = await requireUser("/study/done");
  const t = await getTranslations();
  const now = systemClock.now();
  const status = await dayStatus(getDb(), user.id, now);
  const minutes = Math.max(1, Math.round(status.seconds / 60));

  return (
    <main className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("done.title")}</h1>
        <p className="text-neutral-600 dark:text-neutral-400">{t("done.body")}</p>
      </div>

      {status.cardsDone > 0 && (
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex flex-col gap-0.5 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <dt className="text-xs text-neutral-500">{t("done.todayLabel")}</dt>
            <dd className="text-lg font-medium tabular-nums">
              {t("done.cardsReviewed", { count: status.cardsDone })}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <dt className="text-xs text-neutral-500">{t("done.timeLabel")}</dt>
            <dd className="text-lg font-medium tabular-nums">
              {t("done.minutes", { count: minutes })}
            </dd>
          </div>
        </dl>
      )}

      {status.nextDue && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t("done.nextDue", { when: dueLabel(status.nextDue, now, "en") })}
        </p>
      )}

      {status.dueNow > 0 && (
        <Link
          href="/study"
          className="rounded-lg bg-neutral-900 px-4 py-3 text-center font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          {t("dashboard.cardsDue", { count: status.dueNow })}
        </Link>
      )}

      <Link href="/" className="text-sm underline">
        {t("nav.dashboard")}
      </Link>
    </main>
  );
}

/**
 * "Next card due …", in words the answer actually fits.
 *
 * FSRS learning steps bring a card back in ten minutes, and a bare
 * `toLocaleDateString()` renders that as today's date — technically true and
 * useless. Same day gets a time; anything else gets a date.
 */
function dueLabel(nextDue: Date, now: Date, locale: string): string {
  const sameDay = nextDue.toDateString() === now.toDateString();
  return sameDay
    ? nextDue.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : nextDue.toLocaleDateString(locale);
}
