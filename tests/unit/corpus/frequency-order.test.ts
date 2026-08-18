import { describe, expect, it } from "vitest";

import {
  COURSES,
  freqIndex,
  orderForLoad,
  primaryIndex,
  type FreqRow,
  type WordRow,
} from "@/lib/corpus/load";

/**
 * PLAN.md §5, "how the layers combine": band first, then frequency rank within
 * the band. Before stage 1b the deck ran alphabetically inside each band, so a
 * first session was a run of words starting with `a`.
 *
 * The case worth guarding is the *quiet* one. If the rank lookup misses, every
 * word gets a null rank, the sort falls through to `localeCompare`, and the
 * result is a perfectly valid-looking alphabetical deck with no error anywhere.
 * Several tests below exist to make that failure loud.
 */

const SPEC = COURSES["it-from-en"];

function word(lemma: string, band: string): WordRow {
  return { lemma, band, translations: ["x"] };
}

const FREQ: FreqRow[] = [
  { lemma: "che", freq_rank: 5 },
  { lemma: "casa", freq_rank: 400 },
  { lemma: "acqua", freq_rank: 900 },
  { lemma: "balcone", freq_rank: 7000 },
  { lemma: "zanzara", freq_rank: 20000 },
];

describe("freqIndex", () => {
  it("maps lemma to rank", () => {
    expect(freqIndex(FREQ).get("casa")).toBe(400);
  });

  it("matches case-insensitively", () => {
    // The corpora are lowercased; the curated lists are not. A capitalised
    // lemma that silently failed to match would sort to the end of its band
    // and nothing would report it.
    const index = freqIndex([{ lemma: "roma", freq_rank: 300 }]);
    expect(index.get("Roma".toLowerCase())).toBe(300);
    expect(orderForLoad([word("Roma", "FO")], SPEC, index)[0].freqRank).toBe(300);
  });
});

describe("orderForLoad", () => {
  const ranks = freqIndex(FREQ);

  it("puts band 1 before band 2 before band 3", () => {
    const out = orderForLoad(
      [word("zanzara", "AD"), word("balcone", "AU"), word("casa", "FO")],
      SPEC,
      ranks,
    );
    expect(out.map((r) => r.band)).toEqual(["FO", "AU", "AD"]);
  });

  it("orders by frequency within a band, not alphabetically", () => {
    const out = orderForLoad(
      [word("acqua", "FO"), word("casa", "FO"), word("che", "FO")],
      SPEC,
      ranks,
    );
    expect(out.map((r) => r.lemma)).toEqual(["che", "casa", "acqua"]);
    // Alphabetical would have been acqua, casa, che — the exact order this
    // stage exists to replace.
    expect(out.map((r) => r.lemma)).not.toEqual(["acqua", "casa", "che"]);
  });

  it("attaches the rank so the loader can write freq_rank", () => {
    const out = orderForLoad([word("casa", "FO")], SPEC, ranks);
    expect(out[0].freqRank).toBe(400);
  });

  it("sorts an unranked word to the END of its band, never the start", () => {
    const out = orderForLoad(
      [word("aaa-unranked", "FO"), word("acqua", "FO"), word("che", "FO")],
      SPEC,
      ranks,
    );
    expect(out.map((r) => r.lemma)).toEqual(["che", "acqua", "aaa-unranked"]);
    expect(out[2].freqRank).toBeNull();
  });

  it("keeps an unranked word inside its own band", () => {
    // A null rank must not promote a band-3 word ahead of a band-1 word.
    const out = orderForLoad(
      [word("unranked-ad", "AD"), word("acqua", "FO")],
      SPEC,
      ranks,
    );
    expect(out.map((r) => r.band)).toEqual(["FO", "AD"]);
  });

  it("falls back to alphabetical only when ranks tie", () => {
    const tied = freqIndex([
      { lemma: "zebra", freq_rank: 10 },
      { lemma: "alba", freq_rank: 10 },
    ]);
    const out = orderForLoad([word("zebra", "FO"), word("alba", "FO")], SPEC, tied);
    expect(out.map((r) => r.lemma)).toEqual(["alba", "zebra"]);
  });

  it("does not mutate the rows it was given", () => {
    const rows = [word("acqua", "FO"), word("che", "FO")];
    orderForLoad(rows, SPEC, ranks);
    expect(rows.map((r) => r.lemma)).toEqual(["acqua", "che"]);
    expect(rows[0].freqRank).toBeUndefined();
  });

  it("an empty rank index degrades to alphabetical — the failure this guards", () => {
    // Documents the bad state explicitly, so that if a future change makes the
    // lookup miss, the reader knows what the symptom looks like.
    const out = orderForLoad(
      [word("che", "FO"), word("acqua", "FO")],
      SPEC,
      new Map(),
    );
    expect(out.map((r) => r.lemma)).toEqual(["acqua", "che"]);
    expect(out.every((r) => r.freqRank === null)).toBe(true);
  });
});

/**
 * Stage 5 is a paid pass, so its artifact is optional and the loader must work
 * without it. The failure worth guarding is the quiet one again: if the lookup
 * misses, every card silently falls back to stage 4's shortlist and the deck
 * looks fine.
 */
describe("primaryIndex", () => {
  it("maps lemma to the chosen sense", () => {
    expect(primaryIndex([{ lemma: "casa", primary_sense: "house" }]).get("casa")).toBe(
      "house",
    );
  });

  it("matches case-insensitively and trims", () => {
    const index = primaryIndex([{ lemma: "Roma", primary_sense: "  Rome  " }]);
    expect(index.get("roma")).toBe("Rome");
  });

  it("ignores an empty sense rather than putting a blank on a card", () => {
    const index = primaryIndex([
      { lemma: "casa", primary_sense: "   " },
      { lemma: "acqua", primary_sense: "water" },
    ]);
    expect(index.has("casa")).toBe(false);
    expect(index.get("acqua")).toBe("water");
  });
});
