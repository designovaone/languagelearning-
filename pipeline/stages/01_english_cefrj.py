"""
Stage 1 (English): the curated word list and its CEFR levels.

CEFR-J Vocabulary Profile v1.5 (A1-B2) plus the Octanove profile (C1-C2),
compiled at Tono Laboratory, Tokyo University of Foreign Studies. CC BY-SA 4.0,
explicitly free for commercial use with citation.

Unlike the Italian source (see 01_italian_nvdb.py) this arrives as clean CSV
with the level in a column, so there is nothing to recover.

Two things this stage decides:

1. **One row per (headword, pos).** The source lists a word once per part of
   speech, and those can sit at different levels -- "book" the noun is A1,
   "book" the verb is B1. That distinction is real and worth keeping, because
   the deck is ordered by level.
2. **Slash variants are split.** "a.m./A.M./am/AM" is four spellings of one
   word; the first is kept as the lemma and the rest recorded as variants, so
   the drill's answer matching can accept any of them later (PLAN.md SS7.3).

Input : pipeline/raw/cefrj-vocabulary-profile-1.5.csv, octanove-c1c2-1.0.csv
Output: pipeline/artifacts/en-01-words.jsonl
"""

import csv
import json
import sys
from collections import Counter
from pathlib import Path

from _sources import write_manifest

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "pipeline" / "raw"
OUT = ROOT / "pipeline" / "artifacts"

BAND_NUMBER = {"A1": 1, "A2": 2, "B1": 3, "B2": 4, "C1": 5, "C2": 6}

CEFRJ_SOURCE = "cefr-j"
OCTANOVE_SOURCE = "octanove"

EXPECTED_TOTAL = (9000, 10500)
EXPECTED_PER_BAND = {
    "A1": (900, 1400),
    "A2": (1100, 1700),
    "B1": (2100, 2800),
    "B2": (2400, 3100),
    "C1": (900, 1400),
    "C2": (800, 1300),
}


def read(path: Path, source: str) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig") as fh:
        return [{**row, "_source": source} for row in csv.DictReader(fh)]


def main() -> int:
    cefrj = RAW / "cefrj-vocabulary-profile-1.5.csv"
    octanove = RAW / "octanove-c1c2-1.0.csv"
    for path in (cefrj, octanove):
        if not path.exists():
            print(f"missing input: {path}", file=sys.stderr)
            return 2

    raw_rows = read(cefrj, CEFRJ_SOURCE) + read(octanove, OCTANOVE_SOURCE)

    rows: list[dict[str, object]] = []
    seen: dict[tuple[str, str], int] = {}
    bands = Counter()
    skipped = 0

    for row in raw_rows:
        headword = (row.get("headword") or "").strip()
        pos = (row.get("pos") or "").strip().lower()
        level = (row.get("CEFR") or "").strip().upper()

        if not headword or level not in BAND_NUMBER:
            skipped += 1
            continue

        spellings = [p.strip() for p in headword.split("/") if p.strip()]
        if not spellings:
            skipped += 1
            continue
        lemma = spellings[0]
        variants = spellings[1:]

        key = (lemma.lower(), pos)
        if key in seen:
            # The same word and part of speech listed twice. Keep the easier
            # level: meeting it earlier is the safe direction, and a card that
            # turns out too easy is pushed out by FSRS within a few reviews.
            existing = rows[seen[key]]
            if BAND_NUMBER[level] < BAND_NUMBER[str(existing["band"])]:
                bands[existing["band"]] -= 1
                bands[level] += 1
                existing["band"] = level
                existing["band_number"] = BAND_NUMBER[level]
            continue

        seen[key] = len(rows)
        bands[level] += 1
        rows.append(
            {
                "lemma": lemma,
                "variants": variants,
                "pos": pos,
                "band": level,
                "band_number": BAND_NUMBER[level],
                "band_name": level,
                "scheme": "cefr-j",
                "band_source": "cefr-j",
                "source_id": row["_source"],
            }
        )

    problems = []
    if not EXPECTED_TOTAL[0] <= len(rows) <= EXPECTED_TOTAL[1]:
        problems.append(f"expected {EXPECTED_TOTAL} lemmas, got {len(rows)}")
    for band, (low, high) in EXPECTED_PER_BAND.items():
        if not low <= bands[band] <= high:
            problems.append(f"band {band}: expected {low}-{high}, got {bands[band]}")
    if skipped > 50:
        problems.append(f"{skipped} rows skipped, which is more than expected")
    if problems:
        for p in problems:
            print(f"FAIL: {p}", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "en-01-words.jsonl"
    with out_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    manifest = write_manifest({str(r["source_id"]) for r in rows})

    print(f"wrote {len(rows)} lemma/pos pairs -> {out_path.relative_to(ROOT)}")
    print(f"attribution -> {manifest.relative_to(ROOT)}")
    for band in BAND_NUMBER:
        print(f"  {band}  {bands[band]:>5}")
    print(f"  (skipped {skipped} rows with no headword or no level)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
