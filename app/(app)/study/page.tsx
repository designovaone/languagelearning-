import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireUser } from "@/lib/auth/session";

/**
 * The drill lands at M4. What matters at M1 is that this route is behind the
 * session gate: a logged-out visitor is sent to sign-in, never shown a shell.
 */
export default async function StudyPage() {
  await requireUser("/study");
  const t = await getTranslations();

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">
        {t("done.title")}
      </h1>
      <p className="text-neutral-600 dark:text-neutral-400">{t("done.body")}</p>
      <Link href="/" className="text-sm underline">
        {t("nav.dashboard")}
      </Link>
    </main>
  );
}
