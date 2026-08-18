import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { and, desc, eq, isNotNull } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { assessments, bands, courses, enrollments, words } from "@/lib/db/schema";
import { dayStatus } from "@/lib/study/session";
import { systemClock } from "@/lib/time/clock";

/**
 * The dashboard. M4 adds the real due count; the streak and the staleness
 * warning arrive with M7.
 */
export default async function DashboardPage() {
  const user = await requireUser();
  const t = await getTranslations();

  const db = getDb();
  const [enrolled] = await db
    .select({ slug: courses.slug, name: courses.name, courseId: courses.id })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(and(eq(enrollments.userId, user.id), eq(enrollments.active, true)))
    .limit(1);

  const deck = enrolled
    ? await db
        .select({ band: bands.name, number: bands.number, wordId: words.id })
        .from(words)
        .innerJoin(bands, eq(bands.id, words.bandId))
        .where(eq(words.courseId, enrolled.courseId))
    : [];

  // Whether they have ever been assessed decides what this page offers. An
  // unassessed learner sent straight to the drill would meet 7,000 cards all
  // marked new, including every word they already know.
  // `estimatedSize is not null` is what makes it a FINISHED sitting. A row is
  // written when the learner starts, so counting rows would treat someone who
  // opened the page and closed it as assessed — and then offer them a drill
  // over a deck that was never seeded.
  const [sitting] = await db
    .select({ id: assessments.id, size: assessments.estimatedSize })
    .from(assessments)
    .where(
      and(eq(assessments.userId, user.id), isNotNull(assessments.estimatedSize)),
    )
    .orderBy(desc(assessments.takenAt))
    .limit(1);

  // The due count is read here rather than by starting a session: opening a
  // `study_sessions` row from the dashboard would count every glance at it as
  // a study session.
  const status = await dayStatus(db, user.id, systemClock.now());

  const byBand = new Map<string, { number: number; count: number }>();
  for (const row of deck) {
    const entry = byBand.get(row.band) ?? { number: row.number, count: 0 };
    entry.count += 1;
    byBand.set(row.band, entry);
  }
  const bandRows = [...byBand.entries()].sort((a, b) => a[1].number - b[1].number);

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
          {enrolled ? enrolled.name : t("errors.notFound")}
        </p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">
          {deck.length.toLocaleString()}
        </p>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          words in the deck
        </p>

        {bandRows.length > 0 && (
          <ul className="mt-4 flex flex-col gap-1 text-sm">
            {bandRows.map(([name, info]) => (
              <li key={name} className="flex justify-between tabular-nums">
                <span className="text-neutral-600 dark:text-neutral-400">
                  {name}
                </span>
                <span>{info.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}

        {sitting ? (
          <>
            <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
              {t("dashboard.cardsDue", { count: status.dueNow })}
            </p>
            <Link
              href={status.dueNow > 0 ? "/study" : "/study/done"}
              className="mt-2 block rounded-lg bg-neutral-900 px-4 py-3 text-center font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              {/* Nothing due sends the learner to the screen that says so,
                  not into a drill that would have to invent work for them. */}
              {status.dueNow > 0 ? t("dashboard.startSession") : t("done.title")}
            </Link>
          </>
        ) : (
          <Link
            href="/assessment"
            className="mt-5 block rounded-lg bg-neutral-900 px-4 py-3 text-center font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            {t("assessment.title")}
          </Link>
        )}
      </section>

      <nav className="flex gap-4 text-sm">
        <Link href="/settings" className="underline">
          {t("nav.settings")}
        </Link>
        <Link href="/assessment" className="underline">
          {sitting ? t("assessment.retake") : t("assessment.title")}
        </Link>
      </nav>

      <p className="text-xs text-neutral-500">{user.email}</p>
    </main>
  );
}
