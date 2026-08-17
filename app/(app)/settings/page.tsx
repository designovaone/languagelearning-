import { getTranslations } from "next-intl/server";

import { requireUser } from "@/lib/auth/session";

export default async function SettingsPage() {
  const user = await requireUser("/settings");
  const t = await getTranslations("settings");

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {user.email}
      </p>
      <a href="/api/me/export" className="text-sm underline" download>
        {t("exportData")}
      </a>
    </main>
  );
}
