import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { and, desc, eq, isNotNull } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { assessments, bands, courses, enrollments, words } from "@/lib/db/schema";

/**
 * The dashboard. M1 ships the shell and the session gate; the streak, due
 * count and staleness warning arrive with M4 and M7.
 */
export default async function DashboardPage() {
  const user = await requireUser();
  const t = await getTranslations();

  // M1 shipped the shell; this is the first thing on it with a real number
  // behind it. The due count and streak arrive with M4 and M7.
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
          <Link
            href="/study"
            className="mt-5 block rounded-lg bg-neutral-900 px-4 py-3 text-center font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            {t("dashboard.startSession")}
          </Link>
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
