import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  COURSES,
  loadCourse,
  type SourceManifest,
  type WordRow,
} from "@/lib/corpus/load";
import * as schema from "@/lib/db/schema";

import { closeDb, migratedDb, type TestDatabase } from "./helpers/pglite";

/**
 * PLAN.md §12: the fixture corpus loads idempotently, and every source's
 * attribution row is present — a missing attribution is a licence breach and
 * fails the build.
 */

const MANIFEST: SourceManifest = {
  nvdb: {
    name: "Nuovo vocabolario di base",
    attribution: "De Mauro & Chiari",
    url: "https://github.com/pettarin/nvdb",
    license: "Public Domain",
  },
  "wiktextract-it": {
    name: "Wiktionary Italian entries",
    attribution: "Wiktionary contributors",
    url: "https://kaikki.org/",
    license: "CC BY-SA 4.0 and GFDL",
  },
  "cefr-j": {
    name: "CEFR-J Vocabulary Profile v1.5",
    attribution: "Tono Laboratory",
    url: "https://github.com/openlanguageprofiles/olp-en-cefrj",
    license: "CC BY-SA 4.0",
  },
};

const FIXTURE: WordRow[] = [
  { lemma: "casa", band: "FO", translations: ["house", "home"], gender: "f", pos: ["noun"], sourceId: "wiktextract-it" },
  { lemma: "acqua", band: "FO", translations: ["water"], gender: "f", pos: ["noun"], sourceId: "wiktextract-it" },
  { lemma: "balcone", band: "AU", translations: ["balcony"], gender: "m", pos: ["noun"], sourceId: "wiktextract-it" },
  { lemma: "zanzara", band: "AD", translations: ["mosquito"], gender: "f", pos: ["noun"], sourceId: "wiktextract-it" },
  { lemma: "vuoto", band: "AU", translations: [], pos: ["adj"], sourceId: "wiktextract-it" },
];

const SPEC = COURSES["it-from-en"];

describe("corpus loader", () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await migratedDb();
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it("loads the course, its bands and its words", async () => {
    const report = await loadCourse(db, SPEC, FIXTURE, MANIFEST);
    expect(report.words).toBe(4);
    expect(report.bands).toBe(3);

    expect(await db.select().from(schema.courses)).toHaveLength(1);
    expect(await db.select().from(schema.bands)).toHaveLength(3);
    expect(await db.select().from(schema.words)).toHaveLength(4);
  });

  it("is idempotent — loading twice leaves the same rows", async () => {
    await loadCourse(db, SPEC, FIXTURE, MANIFEST);
    const first = await db.select().from(schema.words).orderBy(schema.words.id);

    await loadCourse(db, SPEC, FIXTURE, MANIFEST);
    const second = await db.select().from(schema.words).orderBy(schema.words.id);

    expect(second).toHaveLength(first.length);
    expect(second.map((w) => w.id)).toEqual(first.map((w) => w.id));
  });

  it("updates in place when a translation improves", async () => {
    await loadCourse(db, SPEC, FIXTURE, MANIFEST);
    const improved = FIXTURE.map((row) =>
      row.lemma === "casa" ? { ...row, translations: ["house"] } : row,
    );
    await loadCourse(db, SPEC, improved, MANIFEST);

    const [casa] = await db
      .select()
      .from(schema.words)
      .where(eq(schema.words.id, "it-from-en:casa"));
    expect(casa.translations).toEqual(["house"]);
    expect(await db.select().from(schema.words)).toHaveLength(4);
  });

  it("puts an attribution on every single word", async () => {
    // Not "on most". One unattributed row is the breach.
    await loadCourse(db, SPEC, FIXTURE, MANIFEST);
    const rows = await db.select().from(schema.words);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source, `${row.lemma}.source`).toBeTruthy();
      expect(row.license, `${row.lemma}.license`).toBeTruthy();
      expect(row.source).toContain("Wiktionary");
      expect(row.license).toContain("CC BY-SA");
    }
  });

  it("attributes the course to its curated list", async () => {
    await loadCourse(db, SPEC, FIXTURE, MANIFEST);
    const [course] = await db.select().from(schema.courses);
    expect(course.source).toContain("Nuovo vocabolario di base");
    expect(course.license).toContain("Public Domain");
  });

  it("refuses to load a word whose source is not registered", async () => {
    const orphan = [{ ...FIXTURE[0], sourceId: "some-scrape" }];
    await expect(loadCourse(db, SPEC, orphan, MANIFEST)).rejects.toThrow(
      /No attribution registered for source "some-scrape"/,
    );
    expect(await db.select().from(schema.words)).toHaveLength(0);
  });

  it("refuses a word whose band does not exist in the course", async () => {
    const wrong = [{ ...FIXTURE[0], band: "C3" }];
    await expect(loadCourse(db, SPEC, wrong, MANIFEST)).rejects.toThrow(
      /band "C3"/,
    );
  });

  it("skips a word with no translation rather than loading a blank card", async () => {
    const report = await loadCourse(db, SPEC, FIXTURE, MANIFEST);
    expect(report.skippedNoTranslation).toBe(1);
    const rows = await db.select().from(schema.words);
    expect(rows.map((r) => r.lemma)).not.toContain("vuoto");
  });

  it("records the first translation as the primary sense", async () => {
    await loadCourse(db, SPEC, FIXTURE, MANIFEST);
    const [casa] = await db
      .select()
      .from(schema.words)
      .where(eq(schema.words.id, "it-from-en:casa"));
    expect(casa.primarySense).toBe("house");
  });

  it("keeps gender, which Italian cards need", async () => {
    await loadCourse(db, SPEC, FIXTURE, MANIFEST);
    const rows = await db.select().from(schema.words);
    const byLemma = Object.fromEntries(rows.map((r) => [r.lemma, r]));
    expect(byLemma["casa"].gender).toBe("f");
    expect(byLemma["balcone"].gender).toBe("m");
  });

  it("links every word to a band of its own course", async () => {
    await loadCourse(db, SPEC, FIXTURE, MANIFEST);
    const rows = await db.select().from(schema.words);
    const bandRows = await db.select().from(schema.bands);
    const ids = new Set(bandRows.map((b) => b.id));
    for (const row of rows) {
      expect(ids.has(row.bandId!), `${row.lemma} -> ${row.bandId}`).toBe(true);
    }
  });

  it("loads both courses side by side without collision", async () => {
    await loadCourse(db, SPEC, FIXTURE, MANIFEST);
    await loadCourse(
      db,
      COURSES["en-from-de"],
      [
        {
          lemma: "house",
          band: "A1",
          translations: ["Haus"],
          gender: "n",
          pos: ["noun"],
          sourceId: "nvdb",
        },
      ],
      MANIFEST,
    );
    expect(await db.select().from(schema.courses)).toHaveLength(2);
    expect(await db.select().from(schema.words)).toHaveLength(5);
    // The two decks share no ids even where they share a spelling.
    const rows = await db.select().from(schema.words);
    expect(new Set(rows.map((r) => r.id)).size).toBe(5);
  });
});
