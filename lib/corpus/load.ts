import { sql } from "drizzle-orm";

import { bands, courses, words } from "@/lib/db/schema";

/**
 * Load pipeline artifacts into the database (PLAN.md §5, stage 9).
 *
 * Two properties this has to have:
 *
 * 1. **Idempotent.** Loading twice must leave the same rows. Ids are derived
 *    from the content (`it-from-en:casa`), never generated, so a re-run
 *    updates in place instead of duplicating the deck.
 * 2. **It fails rather than guesses about attribution.** Every content row
 *    carries `source` and `license`; a missing one is a licence breach, so an
 *    unregistered source id stops the load (PLAN.md §4).
 *
 * `db` is a parameter, so the whole loader runs against in-process Postgres in
 * tests with no network.
 */

// The Drizzle database type varies by driver (neon-serverless in production,
// PGlite in tests).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type SourceEntry = {
  name: string;
  attribution: string;
  url: string;
  license: string;
  commercial?: string;
  note?: string;
};

export type SourceManifest = Record<string, SourceEntry>;

export type BandSpec = {
  number: number;
  code: string;
  name: string;
};

export type CourseSpec = {
  slug: string;
  targetLang: string;
  baseLang: string;
  name: string;
  scheme: string;
  /** Source id for the curated list that defines this course's word set. */
  sourceId: string;
  bands: BandSpec[];
};

export type WordRow = {
  lemma: string;
  band: string;
  translations: string[];
  gender?: string | null;
  pos?: string[] | string | null;
  freqRank?: number | null;
  /** Stage 5's chosen sense. Absent until that pass has run. */
  primarySense?: string | null;
  sourceId?: string;
};

export type LoadReport = {
  course: string;
  bands: number;
  words: number;
  skippedNoTranslation: number;
};

export const COURSES: Record<string, CourseSpec> = {
  "it-from-en": {
    slug: "it-from-en",
    targetLang: "it",
    baseLang: "en",
    name: "Italian from English",
    scheme: "nvdb",
    sourceId: "nvdb",
    bands: [
      { number: 1, code: "FO", name: "Fondamentale" },
      { number: 2, code: "AU", name: "Alto uso" },
      { number: 3, code: "AD", name: "Alta disponibilità" },
    ],
  },
  "en-from-de": {
    slug: "en-from-de",
    targetLang: "en",
    baseLang: "de",
    name: "English from German",
    scheme: "cefr-j",
    sourceId: "cefr-j",
    bands: [
      { number: 1, code: "A1", name: "A1" },
      { number: 2, code: "A2", name: "A2" },
      { number: 3, code: "B1", name: "B1" },
      { number: 4, code: "B2", name: "B2" },
      { number: 5, code: "C1", name: "C1" },
      { number: 6, code: "C2", name: "C2" },
    ],
  },
};

export function bandId(courseSlug: string, code: string): string {
  return `${courseSlug}:${code}`;
}

export function wordId(courseSlug: string, lemma: string): string {
  return `${courseSlug}:${lemma}`;
}

/** A row of a `*-01b-freq.jsonl` artifact (PLAN.md §5, stage 1b). */
export type FreqRow = {
  lemma: string;
  freq_rank: number;
};

/**
 * Lemma → blended frequency rank.
 *
 * Lowercased on both sides: the frequency corpora are NFKC-lowercased, while
 * the curated lists keep their own casing. Matching without this drops every
 * capitalised lemma silently, which is the shape of bug this project keeps
 * finding — a lookup that succeeds for the wrong reason.
 */
export function freqIndex(rows: FreqRow[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const row of rows) {
    index.set(row.lemma.toLowerCase(), row.freq_rank);
  }
  return index;
}

/** A row of a `*-05-primary.jsonl` artifact (PLAN.md §5, stage 5). */
export type PrimaryRow = {
  lemma: string;
  primary_sense: string;
};

/**
 * Lemma → chosen primary sense.
 *
 * Stage 5 is a paid pass, so its artifact is optional: without it the loader
 * falls back to translation position 1, which is stage 4's ranking and is
 * usually right. The deck works either way; it is just less precise.
 */
export function primaryIndex(rows: PrimaryRow[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of rows) {
    if (row.primary_sense?.trim()) {
      index.set(row.lemma.toLowerCase(), row.primary_sense.trim());
    }
  }
  return index;
}

/**
 * Band first, then frequency within the band, then alphabetically (PLAN.md §5,
 * "how the layers combine").
 *
 * A word with no rank sorts to the end of its band rather than the start.
 * `Infinity` rather than `-1` for exactly that reason: an unranked word is not
 * the most common word in the language.
 */
export function orderForLoad(
  rows: WordRow[],
  spec: CourseSpec,
  ranks: Map<string, number>,
): WordRow[] {
  const bandOrder = new Map(spec.bands.map((b, i) => [b.code, i]));
  return [...rows]
    .map((row) => ({
      ...row,
      freqRank: ranks.get(row.lemma.toLowerCase()) ?? null,
    }))
    .sort((a, b) => {
      const band =
        (bandOrder.get(a.band) ?? Number.MAX_SAFE_INTEGER) -
        (bandOrder.get(b.band) ?? Number.MAX_SAFE_INTEGER);
      if (band !== 0) return band;
      // MAX_SAFE_INTEGER, not Infinity: two unranked words would give
      // `Infinity - Infinity` = NaN, and a comparator that returns NaN leaves
      // the sort undefined — so the alphabetical fallback silently stops
      // happening for exactly the rows that need it.
      const rank =
        (a.freqRank ?? Number.MAX_SAFE_INTEGER) -
        (b.freqRank ?? Number.MAX_SAFE_INTEGER);
      if (rank !== 0) return rank;
      return a.lemma.localeCompare(b.lemma);
    });
}

function attributionFor(
  manifest: SourceManifest,
  sourceId: string,
): { source: string; license: string } {
  const entry = manifest[sourceId];
  if (!entry) {
    // Refusing here is the point. A word loaded without attribution is a
    // licence breach that nothing downstream would ever report.
    throw new Error(
      `No attribution registered for source "${sourceId}". ` +
        `Add it to pipeline/stages/_sources.py and re-run the stage.`,
    );
  }
  return {
    source: `${entry.name} — ${entry.attribution} (${entry.url})`,
    license: entry.license,
  };
}

const CHUNK = 500;

export async function loadCourse(
  db: AnyDb,
  spec: CourseSpec,
  rows: WordRow[],
  manifest: SourceManifest,
): Promise<LoadReport> {
  const courseAttribution = attributionFor(manifest, spec.sourceId);

  await db
    .insert(courses)
    .values({
      id: spec.slug,
      slug: spec.slug,
      targetLang: spec.targetLang,
      baseLang: spec.baseLang,
      name: spec.name,
      ...courseAttribution,
    })
    .onConflictDoUpdate({
      target: courses.id,
      set: { name: spec.name, ...courseAttribution },
    });

  for (const band of spec.bands) {
    await db
      .insert(bands)
      .values({
        id: bandId(spec.slug, band.code),
        courseId: spec.slug,
        number: band.number,
        name: band.name,
        scheme: spec.scheme,
      })
      .onConflictDoUpdate({
        target: bands.id,
        set: { number: band.number, name: band.name, scheme: spec.scheme },
      });
  }

  const knownBands = new Set(spec.bands.map((b) => b.code));
  let skippedNoTranslation = 0;
  const payload = [];

  for (const row of rows) {
    const translations = (row.translations ?? []).filter((t) => t.trim());
    if (translations.length === 0) {
      // A word with nothing to translate to cannot become a card.
      skippedNoTranslation += 1;
      continue;
    }
    if (!knownBands.has(row.band)) {
      throw new Error(
        `Word "${row.lemma}" has band "${row.band}", which is not one of ` +
          `${[...knownBands].join(", ")} for course ${spec.slug}.`,
      );
    }

    const attribution = attributionFor(manifest, row.sourceId ?? spec.sourceId);
    const pos = Array.isArray(row.pos) ? row.pos[0] : row.pos;

    payload.push({
      id: wordId(spec.slug, row.lemma),
      courseId: spec.slug,
      bandId: bandId(spec.slug, row.band),
      bandSource: spec.sourceId,
      freqRank: row.freqRank ?? null,
      lemma: row.lemma,
      pos: pos ?? null,
      gender: row.gender ?? null,
      translations,
      // Stage 5's decision when it exists, else stage 4's top-ranked
      // translation. Never null: the card needs an answer to show.
      primarySense: row.primarySense?.trim() || translations[0],
      ...attribution,
    });
  }

  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    await db
      .insert(words)
      .values(chunk)
      .onConflictDoUpdate({
        target: words.id,
        set: {
          bandId: sql`excluded.band_id`,
          translations: sql`excluded.translations`,
          primarySense: sql`excluded.primary_sense`,
          gender: sql`excluded.gender`,
          pos: sql`excluded.pos`,
          freqRank: sql`excluded.freq_rank`,
          source: sql`excluded.source`,
          license: sql`excluded.license`,
        },
      });
  }

  return {
    course: spec.slug,
    bands: spec.bands.length,
    words: payload.length,
    skippedNoTranslation,
  };
}
