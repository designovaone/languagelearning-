"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { signIn } from "@/lib/auth-client";

export function SignInForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const data = new FormData(event.currentTarget);
    const result = await signIn.email({
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
    });

    if (result.error) {
      // One message for any failure. Saying "no such account" would confirm
      // which emails are registered.
      setError(t("signInFailed"));
      setBusy(false);
      return;
    }
    router.push(params.get("next") ?? "/");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label={t("email")} name="email" type="email" autoComplete="email" />
      <Field
        label={t("password")}
        name="password"
        type="password"
        autoComplete="current-password"
      />
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
        {t("signIn")}
      </button>
      <Link href="/sign-up" className="mt-2 text-center text-sm underline">
        {t("signUp")}
      </Link>
    </form>
  );
}

export function Field({
  label,
  name,
  type,
  autoComplete,
  required = true,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        className="rounded-lg border border-neutral-300 px-3 py-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
      />
    </label>
  );
}
