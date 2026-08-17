import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/session";

import { SignUpForm } from "./sign-up-form";

export default async function SignUpPage() {
  if (await getSessionUser()) redirect("/");
  const t = await getTranslations("auth");

  return (
    <main>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">
        {t("signUp")}
      </h1>
      <p className="mb-6 text-sm text-neutral-600 dark:text-neutral-400">
        {t("inviteHint")}
      </p>
      <SignUpForm />
    </main>
  );
}
