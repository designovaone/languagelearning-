"""
Stage 4 (English): German translations for the curated lemmas.

Source: kaikki.org's wiktextract of English entries in the English Wiktionary.
Each entry carries a `translations` array; the ones tagged `de` are what the
`en-from-de` course needs.

The upstream file is ~3.2 GB, so matched entries are cached locally on the
first pass (gitignored) and every later change to the parsing below is free.

Three filters that matter:

1. **Regional forms are dropped.** Wiktionary offers "Waerterbueach" and
   "Laexikon" for *dictionary*, tagged Alemannic. Teaching those as the German
   for a word would be actively wrong for a learner in Bavaria.
2. **Multi-word glosses are kept but ranked last.** "frank und frei" is a real
   translation of *free* and a poor first answer.
3. **Gender is captured from the translation's own tags**, because a German
   noun without its article is only half learned.

Input : pipeline/artifacts/en-01-words.jsonl (the curated spine)
Output: pipeline/artifacts/en-04-translations.jsonl
"""

import argparse
import json
import sys
import urllib.request
from collections import Counter
from pathlib import Path

from _sources import write_manifest

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "pipeline" / "artifacts"

URL = "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl"
SOURCE_ID = "wiktextract-en"
CACHE = ROOT / "pipeline" / "raw" / "en-kaikki-matched.jsonl"

MAX_TRANSLATIONS = 8

GENDER_TAGS = {"masculine": "m", "feminine": "f", "neuter": "n"}

# Anything tagged with a regional variety is not the German being learned.
REGIONAL_TAGS = {
    "Alemannic-German",
    "Swiss-German",
    "Low-German",
    "Bavarian",
    "Austrian",
    "Rhine-Franconian",
    "Pennsylvania-German",
    "Hunsrik",
    "Yiddish",
    "Luxembourgish",
    "Middle-High-German",
    "Old-High-German",
}

SKIP_TAGS = {"obsolete", "archaic", "rare", "dialectal", "misspelling"} | REGIONAL_TAGS


def load_spine(path: Path) -> dict[str, list[dict]]:
    """lemma (lowercased) -> the curated rows for it, one per part of speech."""
    spine: dict[str, list[dict]] = {}
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            spine.setdefault(row["lemma"].lower(), []).append(row)
    return spine


def german_translations(entry: dict) -> tuple[list[str], str | None]:
    """
    German translations for one entry, best first.

    wiktextract puts a word's translation table at the top level for some
    entries and under individual senses for others -- "dictionary" has one at
    the top, "dog" does not. Reading only the top level silently lost the
    majority of common words, which is what the coverage guard caught.

    **Ranking is the harder half.** Taken in document order, `dog` yields
    "Ruede, Schabracke, Hund" -- a male dog, an insult, and only then the
    actual word. Tags cannot fix this: the dialect forms "Wossa" and "wassa"
    for *water* carry no regional tag at all, just `neuter` or nothing.

    The signal that works is **repetition**. A word that translates several
    senses of the entry is the standard one; a regional or narrow variant
    appears once. "Wasser" occurs six times against one each for "Wossa" and
    "wassa"; "Hund" four times against one for "Schabracke". So rank by how
    often a form recurs, then by the earliest sense it belongs to, then prefer
    a single word over a phrase.

    This is a ranking, not a decision. Choosing the one primary sense is stage
    5's job (PLAN.md SS5), and it gets a much better shortlist this way.
    """
    counts: Counter = Counter()
    first_seen: dict[str, int] = {}
    gender_of: dict[str, set[str]] = {}

    items: list[tuple[int, dict]] = [
        (0, item) for item in (entry.get("translations") or [])
    ]
    for index, sense in enumerate(entry.get("senses") or [], start=1):
        items.extend((index, item) for item in (sense.get("translations") or []))

    for order, item in items:
        if item.get("code") != "de":
            continue
        tags = set(item.get("tags") or [])
        if tags & SKIP_TAGS:
            continue
        word = (item.get("word") or "").strip()
        if not word:
            continue
        for tag, short in GENDER_TAGS.items():
            if tag in tags:
                gender_of.setdefault(word, set()).add(short)
        counts[word] += 1
        first_seen.setdefault(word, order)

    ranked = sorted(
        counts,
        key=lambda w: (-counts[w], first_seen[w], " " in w, w),
    )
    # The gender that matters is the one belonging to the word actually shown.
    # Requiring every translation to agree meant "dog" -> Hund (m) plus
    # Schabracke (f) recorded no gender at all, and a German noun without its
    # article is only half learned.
    top_genders = gender_of.get(ranked[0], set()) if ranked else set()
    gender = next(iter(top_genders)) if len(top_genders) == 1 else None
    return ranked[:MAX_TRANSLATIONS], gender


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--url", default=URL)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    spine_path = ARTIFACTS / "en-01-words.jsonl"
    if not spine_path.exists():
        print(f"missing input: {spine_path} (run 01_english_cefrj.py first)", file=sys.stderr)
        return 2

    spine = load_spine(spine_path)
    collected: dict[str, dict] = {}
    stats = Counter()

    if CACHE.exists() and not args.refresh and not args.limit:
        print(f"reading cache {CACHE.relative_to(ROOT)}", file=sys.stderr)
        source = CACHE.open("rb")
        cache_out = None
    else:
        print(f"streaming {args.url} (~3.2 GB, one pass)", file=sys.stderr)
        request = urllib.request.Request(args.url, headers={"User-Agent": "languagelearning-pipeline/1.0"})
        source = urllib.request.urlopen(request)
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        cache_out = None if args.limit else CACHE.open("w", encoding="utf-8")

    with source:
        for raw in source:
            stats["records"] += 1
            if args.limit and stats["records"] > args.limit:
                break
            if stats["records"] % 500_000 == 0:
                print(f"  {stats['records']:,} records, {len(collected):,} lemmas matched", file=sys.stderr)

            try:
                entry = json.loads(raw)
            except json.JSONDecodeError:
                stats["unparseable"] += 1
                continue

            if entry.get("lang_code") != "en":
                continue
            word = (entry.get("word") or "").strip().lower()
            if word not in spine:
                continue

            if cache_out is not None:
                cache_out.write(json.dumps(entry, ensure_ascii=False) + "\n")

            words, gender = german_translations(entry)
            if not words:
                stats["no_german"] += 1
                continue

            row = collected.setdefault(
                word, {"translations": [], "gender": None, "pos": []}
            )
            for candidate in words:
                if candidate not in row["translations"] and len(row["translations"]) < MAX_TRANSLATIONS:
                    row["translations"].append(candidate)
            pos = entry.get("pos")
            if pos and pos not in row["pos"]:
                row["pos"].append(pos)
            if gender and row["gender"] is None:
                row["gender"] = gender

    if cache_out is not None:
        cache_out.close()
        print(f"cached matched entries -> {CACHE.relative_to(ROOT)}", file=sys.stderr)

    out_rows = []
    for lemma, rows in spine.items():
        found = collected.get(lemma)
        if not found:
            stats["unmatched"] += 1
            continue
        best = min(rows, key=lambda r: r["band_number"])
        out_rows.append(
            {
                "lemma": best["lemma"],
                "variants": best.get("variants") or [],
                "band": best["band"],
                "band_number": best["band_number"],
                "pos": found["pos"],
                "gender": found["gender"],
                "translations": found["translations"],
                "source_id": SOURCE_ID,
            }
        )

    coverage = len(out_rows) / max(len(spine), 1)
    print(
        f"\nrecords read : {stats['records']:,}\n"
        f"lemmas wanted: {len(spine):,}\n"
        f"lemmas found : {len(out_rows):,}  ({coverage:.1%})\n"
        f"unmatched    : {stats['unmatched']:,}\n"
        f"no German    : {stats['no_german']:,}",
        file=sys.stderr,
    )

    if not args.limit and coverage < 0.70:
        print(f"FAIL: coverage {coverage:.1%} is below 70%", file=sys.stderr)
        return 1

    out_path = ARTIFACTS / "en-04-translations.jsonl"
    with out_path.open("w", encoding="utf-8") as fh:
        for row in out_rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    write_manifest({SOURCE_ID})
    print(f"wrote {len(out_rows)} lemmas -> {out_path.relative_to(ROOT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
