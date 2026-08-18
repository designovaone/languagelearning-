/**
 * Load the pipeline artifacts into the database (PLAN.md §5, stage 9).
 *
 *   node --env-file=.env.local node_modules/.bin/tsx scripts/load-corpus.ts
 *   ... --course it-from-en      just one course
 *   ... --limit 200              a small slice, for a first look
 *
 * Idempotent: ids are derived from the content, so running it again updates
 * the deck in place rather than duplicating it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COURSES,
  freqIndex,
  loadCourse,
  orderForLoad,
  type FreqRow,
  type SourceManifest,
  type WordRow,
} from "@/lib/corpus/load";
import { closeDb, getDb } from "@/lib/db";

const ROOT = join(import.meta.dirname, "..");
const ARTIFACTS = join(ROOT, "pipeline", "artifacts");

const ARTIFACT_FOR: Record<string, string> = {
  "it-from-en": "it-04-translations.jsonl",
  "en-from-de": "en-04-translations.jsonl",
};

/** Stage 1b output: the blended frequency rank that orders each band. */
const FREQ_FOR: Record<string, string> = {
  "it-from-en": "it-01b-freq.jsonl",
  "en-from-de": "en-01b-freq.jsonl",
};

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run with --env-file=.env.local");
    return 2;
  }

  const manifest = JSON.parse(
    readFileSync(join(ARTIFACTS, "sources.json"), "utf8"),
  ) as SourceManifest;

  const only = arg("course");
  const limitRaw = arg("limit");
  const limit = limitRaw ? Number(limitRaw) : 0;
  if (limitRaw && (!Number.isFinite(limit) || limit <= 0)) {
    console.error("--limit must be a positive number");
    return 2;
  }

  const slugs = only ? [only] : Object.keys(COURSES);
  for (const slug of slugs) {
    const spec = COURSES[slug];
    if (!spec) {
      console.error(`Unknown course "${slug}". Known: ${Object.keys(COURSES).join(", ")}`);
      return 2;
    }

    const path = join(ARTIFACTS, ARTIFACT_FOR[slug]);
    let rows: WordRow[];
    try {
      rows = readJsonl<WordRow>(path);
    } catch {
      console.error(`Missing artifact ${path}. Run the pipeline stages first.`);
      return 2;
    }

    // Band first, then frequency within the band (PLAN.md §5, stage 1b).
    // The frequency artifact is required: loading without it would quietly
    // restore the alphabetical deck, and nothing downstream would report it.
    const freqPath = join(ARTIFACTS, FREQ_FOR[slug]);
    let ranks;
    try {
      ranks = freqIndex(readJsonl<FreqRow>(freqPath));
    } catch {
      console.error(
        `Missing frequency artifact ${freqPath}. ` +
          `Run pipeline/stages/01b_frequency.py first.`,
      );
      return 2;
    }

    const ordered = orderForLoad(rows, spec, ranks);
    const unranked = ordered.filter((r) => r.freqRank == null).length;
    const slice = limit ? ordered.slice(0, limit) : ordered;
    const report = await loadCourse(getDb(), spec, slice, manifest);

    console.error(
      `${report.course}: ${report.words} words in ${report.bands} bands` +
        (report.skippedNoTranslation
          ? ` (${report.skippedNoTranslation} skipped, no translation)`
          : "") +
        (unranked ? ` (${unranked} with no frequency rank, sorted last)` : ""),
    );
  }

  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
