/**
 * UI locales.
 *
 * **No locale routing and no `proxy.ts`** (PLAN.md §2). The locale is a
 * per-user setting stored in `profiles.ui_locale`, which keeps URLs stable and
 * sidesteps the Next 16 middleware→proxy migration entirely.
 *
 * UI locale, base language and target language are three different things and
 * are kept strictly separate. A learner studying English from German needs
 * German explanations; conflating these is the most likely quiet failure.
 */
export const LOCALES = ["en", "de"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** The cookie that carries the locale for a logged-out visitor. */
export const LOCALE_COOKIE = "ui_locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function coerceLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
