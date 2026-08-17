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
  loadCourse,
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

    // Band first, then alphabetically. Ordering *within* a band should be by
    // frequency (PLAN.md §5), which needs stage 1b; until then the queue will
    // walk a band alphabetically. Recorded in ISSUES.md.
    rows.sort((a, b) => {
      const bandA = spec.bands.findIndex((x) => x.code === a.band);
      const bandB = spec.bands.findIndex((x) => x.code === b.band);
      return bandA - bandB || a.lemma.localeCompare(b.lemma);
    });

    const slice = limit ? rows.slice(0, limit) : rows;
    const report = await loadCourse(getDb(), spec, slice, manifest);

    console.error(
      `${report.course}: ${report.words} words in ${report.bands} bands` +
        (report.skippedNoTranslation
          ? ` (${report.skippedNoTranslation} skipped, no translation)`
          : ""),
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
