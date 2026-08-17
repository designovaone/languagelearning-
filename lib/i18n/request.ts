import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { coerceLocale, LOCALE_COOKIE, type Locale } from "./locales";

/**
 * Resolves the UI locale **without locale routing** (PLAN.md §2).
 *
 * Order: the signed-in learner's stored preference, then a cookie for someone
 * who is logged out, then the default. URLs never carry a locale, so they stay
 * stable and there is no `proxy.ts` to migrate.
 *
 * `cookies()` and `headers()` are async-only in Next 16.
 */
async function resolveLocale(): Promise<Locale> {
  const stored = await localeFromSession();
  if (stored) return stored;

  const cookieStore = await cookies();
  return coerceLocale(cookieStore.get(LOCALE_COOKIE)?.value);
}

async function localeFromSession(): Promise<Locale | null> {
  try {
    // Imported lazily: this module is loaded for every request, including ones
    // that never touch the database.
    const [{ getAuth }, { getDb }, { profiles }, { eq }] = await Promise.all([
      import("@/lib/auth"),
      import("@/lib/db"),
      import("@/lib/db/schema"),
      import("drizzle-orm"),
    ]);

    const session = await getAuth().api.getSession({
      headers: await headers(),
    });
    if (!session?.user?.id) return null;

    const rows = await getDb()
      .select({ uiLocale: profiles.uiLocale })
      .from(profiles)
      .where(eq(profiles.userId, session.user.id))
      .limit(1);

    return rows[0] ? coerceLocale(rows[0].uiLocale) : null;
  } catch {
    // A database hiccup must not blank the interface. Fall through to the
    // cookie and the default.
    return null;
  }
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
