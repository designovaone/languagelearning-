# Content pipeline

Builds the deck from openly-licensed sources. Runs **once, offline, on a laptop** —
nothing here executes in production (PLAN.md §5).

```bash
pip3 install -r pipeline/requirements.txt
pipeline/stages/00_fetch_sources.sh
cd pipeline/stages && python3 01_italian_nvdb.py && python3 01_english_cefrj.py
```

## What is and isn't checked in

| | |
|---|---|
| `raw/` | **Gitignored.** Large, unmodified, re-fetchable with `00_fetch_sources.sh` |
| `artifacts/` | **Checked in.** What the loader reads. A re-run must never repeat a paid step |
| `artifacts/sources.json` | Generated attribution. Never hand-written — a missing attribution is a licence breach |

Rows carry a short `source_id`; `sources.json` holds the full citation and licence.

## Stages

| | Stage | Status |
|---|---|---|
| 0 | Fetch sources | ✅ |
| 1 | **Curated list — the spine.** CEFR-J (English, A1–C2), NVdB (Italian, FO/AU/AD) | ✅ |
| 1b | Frequency blend — tie-breaker within a band, not the source of the deck | |
| 2 | Lemmatise (spaCy) — needed for the frequency blend, not for the curated lists | |
| 3 | Filter — proper nouns, numerals, fragments, profanity | |
| 4 | **Translate** (kaikki.org / wiktextract). Italian→English 98.6% coverage | ✅ IT |
| 5 | Pick primary sense — one-time AI pass | |
| 6 | Topic-cluster — one-time AI pass | |
| 7 | Sentences (Tatoeba) | |
| 8 | Audio (Kokoro-82M, local) | |
| 9 | Load into the database | |

## The Italian bands are recovered from the PDF

Worth knowing before anyone "simplifies" stage 1.

The NVdB encodes its three usage bands as **typography**: fondamentale in bold, alto uso in
regular, alta disponibilità in italic. Every plain-text extraction loses this, including the
one in the source repository — `nvdb.full.txt` has all 7,248 lemmas and zero band markers.

Since the band *is* the learning order for Italian, stage 1 reads the fonts back out of the
published PDF. Recovered counts land within a few percent of the figures the authors state:

| Band | Recovered | Published |
|---|---|---|
| FO | 2,020 | "circa duemila" |
| AU | 3,000 | "circa tremila" |
| AD | 2,229 | "circa 2.500" |

The stage refuses to write its artifact if those counts drift outside a sanity range, or if
too many styled headwords fail to match an entry. That guard is what caught the PDF's
soft-hyphen line breaks — 158 fragments like `acceca-` + `mento` that would otherwise have
been silently dropped from the FO band.
