"""
Stage 4 (Italian): English translations for the curated lemmas.

Source: kaikki.org's wiktextract of Italian entries in the English Wiktionary.
Those entries define Italian words *in English*, which is exactly the direction
the `it-from-en` course needs.

The upstream file is ~760 MB. It is **streamed and filtered in one pass** rather
than downloaded: only ~7,200 lemmas are wanted, the artifact is a few MB, and
re-running should cost nothing but bandwidth. Nothing large is kept on disk.

Two filters that matter:

1. **Inflected forms are dropped.** Wiktionary carries "andiamo" as a sense
   reading "first-person plural present of andare". Keeping those would teach
   the conjugation table as if it were vocabulary, and would put a translation
   on a card that is really a grammar fact.
2. **Only senses the learner can act on.** Obsolete, rare and dialectal senses
   are skipped, because the first translation shown is the one the drill
   grades against.

Input : pipeline/artifacts/it-01-words.jsonl (the curated spine)
Output: pipeline/artifacts/it-04-translations.jsonl
"""

import argparse
import json
import re
import sys
import urllib.request
from collections import Counter
from pathlib import Path

from _sources import write_manifest

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "pipeline" / "artifacts"

URL = "https://kaikki.org/dictionary/Italian/kaikki.org-dictionary-Italian.jsonl"
SOURCE_ID = "wiktextract-it"

# The 760 MB stream is filtered once into this cache (gitignored, a few MB), so
# every later change to the parsing below costs nothing. Re-download with
# --refresh when the upstream extract is updated.
CACHE = ROOT / "pipeline" / "raw" / "it-kaikki-matched.jsonl"

MAX_GLOSSES = 8

# Senses that exist for completeness, not for a learner meeting the word.
SKIP_TAGS = {
    "obsolete",
    "archaic",
    "rare",
    "dialectal",
    "misspelling",
    "alt-of",
    "form-of",
    "abbreviation",
    "initialism",
}

GENDER_TAGS = {"masculine": "m", "feminine": "f"}

# "feminine plural of pio", "first-person singular present of andare", ...
FORM_OF_GLOSS = re.compile(
    r"^\s*(inflection|plural|singular|feminine|masculine|first|second|third|past|present|future|gerund|participle|imperative|subjunctive|conditional)\b.*\bof\b",
    re.IGNORECASE,
)


def load_lemmas(path: Path) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            rows.setdefault(row["lemma"], row)
    return rows


def usable_glosses(entry: dict) -> tuple[list[str], set[str]]:
    """English glosses worth showing, plus any gender tags seen."""
    glosses: list[str] = []
    genders: set[str] = set()

    for sense in entry.get("senses") or []:
        tags = set(sense.get("tags") or [])
        if tags & SKIP_TAGS:
            continue
        for tag, short in GENDER_TAGS.items():
            if tag in tags:
                genders.add(short)
        for gloss in sense.get("glosses") or []:
            text = gloss.strip()
            if not text or FORM_OF_GLOSS.match(text):
                continue
            if text not in glosses:
                glosses.append(text)

    return glosses, genders


def gender_from_head(entry: dict) -> set[str]:
    """
    Gender from the headword template's **arguments**, not its rendered text.

    The rendered expansion is a trap: "cane m (plural cani, feminine cagna,
    diminutive canino m or canina f ...)" mentions both genders, because it
    lists the diminutives with theirs. Reading it made almost every Italian
    noun look ambiguous, and the gender was silently dropped -- the word still
    loaded, still drilled, and just never taught its article.

    The Italian noun template carries the real answer in arg "1"; the generic
    head template uses "g".
    """
    found: set[str] = set()
    for template in entry.get("head_templates") or []:
        args = template.get("args") or {}
        for key in ("1", "g", "2"):
            value = str(args.get(key, "")).strip().lower()
            if value in {"m", "f"}:
                found.add(value)
            elif value in {"m-p", "f-p"}:
                found.add(value[0])
    return found


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="stop after N input records (for a smoke run)")
    parser.add_argument("--url", default=URL)
    parser.add_argument("--refresh", action="store_true", help="re-stream the upstream file even if the cache exists")
    args = parser.parse_args()

    spine_path = ARTIFACTS / "it-01-words.jsonl"
    if not spine_path.exists():
        print(f"missing input: {spine_path} (run 01_italian_nvdb.py first)", file=sys.stderr)
        return 2

    wanted = load_lemmas(spine_path)
    collected: dict[str, dict] = {}
    stats = Counter()

    if CACHE.exists() and not args.refresh and not args.limit:
        print(f"reading cache {CACHE.relative_to(ROOT)}", file=sys.stderr)
        source = CACHE.open("rb")
        cache_out = None
    else:
        print(f"streaming {args.url}", file=sys.stderr)
        request = urllib.request.Request(args.url, headers={"User-Agent": "languagelearning-pipeline/1.0"})
        source = urllib.request.urlopen(request)
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        cache_out = None if args.limit else CACHE.open("w", encoding="utf-8")

    with source:
        for raw in source:
            stats["records"] += 1
            if args.limit and stats["records"] > args.limit:
                break
            if stats["records"] % 250_000 == 0:
                print(f"  {stats['records']:,} records, {len(collected):,} lemmas matched", file=sys.stderr)

            try:
                entry = json.loads(raw)
            except json.JSONDecodeError:
                stats["unparseable"] += 1
                continue

            if entry.get("lang_code") != "it":
                continue
            word = (entry.get("word") or "").strip().lower()
            if word not in wanted:
                continue

            if cache_out is not None:
                cache_out.write(json.dumps(entry, ensure_ascii=False) + "\n")

            glosses, genders = usable_glosses(entry)
            if not glosses:
                stats["no_usable_sense"] += 1
                continue

            genders |= gender_from_head(entry)

            row = collected.setdefault(
                word,
                {"lemma": word, "translations": [], "pos": [], "gender": None},
            )
            for gloss in glosses:
                if gloss not in row["translations"] and len(row["translations"]) < MAX_GLOSSES:
                    row["translations"].append(gloss)
            pos = entry.get("pos")
            if pos and pos not in row["pos"]:
                row["pos"].append(pos)
            if genders and row["gender"] is None:
                # Some nouns really are both (il/la cantante). Say so rather
                # than dropping the information.
                row["gender"] = "mf" if len(genders) > 1 else next(iter(genders))

    if cache_out is not None:
        cache_out.close()
        print(f"cached matched entries -> {CACHE.relative_to(ROOT)}", file=sys.stderr)

    out_rows = []
    for lemma, spine in wanted.items():
        found = collected.get(lemma)
        if not found:
            stats["unmatched"] += 1
            continue
        out_rows.append(
            {
                "lemma": lemma,
                "band": spine["band"],
                "band_number": spine["band_number"],
                "pos": found["pos"],
                "gender": found["gender"],
                "translations": found["translations"],
                "source_id": SOURCE_ID,
            }
        )

    coverage = len(out_rows) / max(len(wanted), 1)
    print(
        f"\nrecords read : {stats['records']:,}\n"
        f"lemmas wanted: {len(wanted):,}\n"
        f"lemmas found : {len(out_rows):,}  ({coverage:.1%})\n"
        f"unmatched    : {stats['unmatched']:,}\n"
        f"no sense     : {stats['no_usable_sense']:,}",
        file=sys.stderr,
    )

    if not args.limit and coverage < 0.80:
        # Below this the deck has holes big enough to notice, and the cause is
        # more likely a changed upstream format than a genuinely missing word.
        print(f"FAIL: coverage {coverage:.1%} is below 80%", file=sys.stderr)
        return 1

    out_path = ARTIFACTS / "it-04-translations.jsonl"
    with out_path.open("w", encoding="utf-8") as fh:
        for row in out_rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    write_manifest({SOURCE_ID})
    print(f"wrote {len(out_rows)} lemmas -> {out_path.relative_to(ROOT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
