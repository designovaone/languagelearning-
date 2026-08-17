import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getSessionUser } from "@/lib/auth/session";

import { SignInForm } from "./sign-in-form";

export default async function SignInPage() {
  if (await getSessionUser()) redirect("/");
  const t = await getTranslations("auth");

  return (
    <main>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        {t("signIn")}
      </h1>
      {/* useSearchParams needs a Suspense boundary. */}
      <Suspense>
        <SignInForm />
      </Suspense>
    </main>
  );
}
