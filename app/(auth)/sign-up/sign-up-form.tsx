"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field } from "../sign-in/sign-in-form";
import { signUp } from "@/lib/auth-client";
import { LOCALES } from "@/lib/i18n/locales";

const MIN_PASSWORD_LENGTH = 12;

export function SignUpForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? "");
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("passwordTooShort"));
      return;
    }

    setBusy(true);
    const uiLocale = String(data.get("uiLocale") ?? "en");
    const result = await signUp.email({
      name: String(data.get("name") ?? ""),
      email: String(data.get("email") ?? ""),
      password,
      // Read by the invite gate and the profile hook (lib/auth.ts).
      fetchOptions: {
        body: {
          inviteCode: String(data.get("inviteCode") ?? ""),
          uiLocale,
          baseLang: uiLocale,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      },
    });

    if (result.error) {
      setError(t("inviteRejected"));
      setBusy(false);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label={t("name")} name="name" type="text" autoComplete="name" />
      <Field label={t("email")} name="email" type="email" autoComplete="email" />
      <Field
        label={t("password")}
        name="password"
        type="password"
        autoComplete="new-password"
      />
      <Field label={t("inviteCode")} name="inviteCode" type="text" />
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Language</span>
        <select
          name="uiLocale"
          defaultValue="en"
          className="rounded-lg border border-neutral-300 px-3 py-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
        >
          {LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {locale === "de" ? "Deutsch" : "English"}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="mt-2 rounded-lg bg-neutral-900 px-4 py-3 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {t("signUp")}
      </button>
      <Link href="/sign-in" className="mt-2 text-center text-sm underline">
        {t("signIn")}
      </Link>
    </form>
  );
}
