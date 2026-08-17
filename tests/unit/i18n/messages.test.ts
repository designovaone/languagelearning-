import { describe, expect, it } from "vitest";

import de from "@/lib/i18n/messages/de.json";
import en from "@/lib/i18n/messages/en.json";
import { DEFAULT_LOCALE, isLocale, LOCALES } from "@/lib/i18n/locales";

/**
 * PLAN.md §12: both locale files have identical key sets — catches a
 * half-translated UI early.
 *
 * A missing German key does not crash; next-intl falls back or renders the key
 * name. So the failure is one learner quietly reading English in a German
 * interface, and nobody files that as a bug. It has to be a build failure.
 */

type Messages = Record<string, unknown>;

function flatten(obj: Messages, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value !== null && typeof value === "object"
      ? flatten(value as Messages, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

/**
 * ICU *arguments* like `{count}` and `{count, plural, ...}`.
 *
 * The name must be followed by `}` or `,`, which is what separates an argument
 * from a plural branch body such as `=0 {Nothing due}` — those are translated
 * text, not placeholders, and counting them would flag every plural string.
 */
function placeholders(value: string): string[] {
  const found = [...value.matchAll(/\{\s*(\w+)\s*(?=[,}])/g)].map((m) => m[1]);
  return [...new Set(found)].sort();
}

function entries(obj: Messages, prefix = ""): [string, string][] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value !== null && typeof value === "object"
      ? entries(value as Messages, `${prefix}${key}.`)
      : ([[`${prefix}${key}`, String(value)]] as [string, string][]),
  );
}

const enKeys = flatten(en).sort();
const deKeys = flatten(de).sort();

describe("locale files", () => {
  it("has messages to check", () => {
    expect(enKeys.length).toBeGreaterThan(20);
  });

  it("covers every configured locale", () => {
    expect([...LOCALES].sort()).toEqual(["de", "en"]);
    expect(isLocale(DEFAULT_LOCALE)).toBe(true);
  });

  it("has identical key sets in en and de", () => {
    expect(deKeys).toEqual(enKeys);
  });

  it("names the missing keys rather than just failing", () => {
    expect(enKeys.filter((k) => !deKeys.includes(k))).toEqual([]);
    expect(deKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
  });

  it("uses the same ICU placeholders in both languages", () => {
    // A translated string that drops {count} renders a sentence with a hole in
    // it. Same class of silent failure as a missing key, one level deeper.
    const deMap = new Map(entries(de));
    const mismatched: string[] = [];
    for (const [key, value] of entries(en)) {
      const other = deMap.get(key);
      if (other === undefined) continue;
      const a = placeholders(value);
      const b = placeholders(other);
      if (a.join(",") !== b.join(",")) {
        mismatched.push(`${key}: en[${a.join(",")}] vs de[${b.join(",")}]`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("has no empty strings standing in for a translation", () => {
    const empty = entries(de)
      .filter(([, value]) => value.trim().length === 0)
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it("has no German value left identical to a long English one", () => {
    // Short labels legitimately match ("Name", "Email"). A long identical
    // string is almost always an untranslated placeholder.
    const deMap = new Map(entries(de));
    const suspicious = entries(en)
      .filter(([key, value]) => value.length > 25 && deMap.get(key) === value)
      .map(([key]) => key);
    expect(suspicious).toEqual([]);
  });
});
