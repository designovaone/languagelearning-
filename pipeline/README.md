# Content pipeline

Builds the deck from openly-licensed sources. Runs **once, offline, on a laptop** —
nothing here executes in production (PLAN.md §5).

```bash
pip3 install -r pipeline/requirements.txt
pipeline/stages/00_fetch_sources.sh
cd pipeline/stages && python3 01_italian_nvdb.py && python3 01_english_cefrj.py
python3 01b_frequency.py
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
| 1b | **Frequency blend** — tie-breaker within a band, not the source of the deck | ✅ |
| 2 | Lemmatise (spaCy) — needed for the frequency blend, not for the curated lists | |
| 3 | Filter — proper nouns, numerals, fragments, profanity | |
| 4 | **Translate** (kaikki.org / wiktextract). IT→EN 98.6%, EN→DE 90.4% | ✅ |
| 5 | **Pick primary sense** — one-time AI pass, `google/gemini-2.5-flash-lite`, **$0.07** | ✅ |
| 6 | Topic-cluster — one-time AI pass | |
| 7 | Sentences (Tatoeba) | |
| 8 | Audio (Kokoro-82M, local) | |
| 9 | **Load into the database** — `npm run corpus:load`, idempotent | ✅ |
| 20 | **Pseudowords** — assessment traps, not deck content (M3) | ✅ |

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


## Stage 4 ranks translations by repetition

Wiktionary gives a word many translations across many senses, in no useful order. Taken as
they come, `dog` yields *Rüde, Schabracke, Hund* — a male dog, an insult, and only then the
word anyone wants.

Tags cannot fix this. The dialect forms `Wossa` and `wassa` for *water* carry no regional tag
at all — just `neuter`, or nothing.

What works is **repetition**: a form that translates several senses of the entry is the
standard one, while a regional or narrow variant appears once. `Wasser` occurs six times
against one each for `Wossa` and `wassa`; `Hund` four times against one for `Schabracke`. So
translations are ranked by recurrence, then by earliest sense, then single word before phrase.

That is a ranking, not a decision — picking the one primary sense is stage 5's job. It just
gets a far better shortlist to choose from.


## Stage 1b blends two corpora that disagree on purpose

Subtitles know `ciao`, `beh` and `domani`; Wikipedia knows `provincia` and `febbraio`. Neither
register alone is what a learner needs, so the stage takes the **geometric** mean of the two ranks.

The plain average would be wrong, and measurably so: it is dominated by whichever corpus rates the
word worst, so `ciao` (subtitles #153, wikipedia #15,068) lands at 1,611 — behind `bosco`
("woods"). The geometric mean puts it at 683. See PLAN.md §5, "Why the geometric mean".

Two rules settled by looking at the data rather than by picking a constant:

- **Missing from one corpus → use the other, no penalty.** The Wikipedia list treats `-` and `'`
  as word-breaking, so `e-mail`, `ping-pong` and `o'clock` can never appear in it. Penalising a
  tokenisation artifact would be simply wrong. The genuinely register-bound words (`altoatesino`)
  already carry a poor rank where they do appear.
- **A phrase takes the rank of its rarest component** — it cannot be more common than that.

The stage refuses to write if coverage falls under 95%, if under 90% of ranks used both corpora, or
if a canary word (`essere`, `casa`, `ciao`, `the`, `water`, …) falls outside the top 5,000. A wrong
ranking still looks exactly like a ranking, so it needs a check that knows what the answer is.


## Stage 5 cleans before it chooses

Stage 4's shortlist is two different problems in the two courses. English→German options are clean
words; Italian→English options are often *definitions* — `crescere` → "to grow, to increase, to
expand", `atmosfera` → "atmosphere (all meanings), air". 56.3% of Italian first-translations are a
gloss rather than a word, against 0.2% of the English ones.

So `simplify()` runs first, deterministically and for free: drop parentheticals, keep the first
comma- or semicolon-separated equivalent. The model is only asked where a genuine choice survives.

```bash
cd pipeline/stages
python3 test_05_primary_sense.py                       # the pure logic, stdlib only
python3 05_primary_sense.py --dry-run --sample 20      # free, writes nothing
export OPENROUTER_API_KEY=...
python3 05_primary_sense.py --lang it --limit 50 --sample 50   # eyeball first
python3 05_primary_sense.py                            # the full pass
```

**The model may choose or extract; it may not invent.** An answer is accepted if it *is* one of the
candidates, or if it appears inside one on whole-word boundaries — Wiktionary buries the real
translation inside a definition often enough that exact matching alone put "any member of the
Cygnus taxonomic genus" on the swan card. Either way every word came from the source. Anything else
is discarded and counted, and the stage refuses to write above a 10% fallback rate. Canary words
(`casa`→house, `dog`→Hund, …) must come back right, because a wrong translation looks exactly like
a right one.

**As run (2026-08-18):** 14,904 cards, 12,346 decisions, **4 fallbacks (0.03%)**, $0.07 total.

`{lang}-05-primary.jsonl` is output and cache in one, checked in, resumable. `--dry-run` never
writes — an artifact full of fallbacks looks finished and is not.


## Stage 20 generates the assessment's pseudowords

Numbered outside the 1–9 content sequence because nothing it produces reaches a flashcard. It is
here because it has the pipeline's shape: offline, deterministic, seeded, writes a checked-in
artifact, never runs in production.

A character trigram model (the Wuggy approach) over the most frequent real words, sampled until it
emits its own end marker. **Length is not steered** — an earlier version drew a target length and
suppressed the end marker until it was reached, which pushed the Italian mean from 7.7 characters
to 10.0. Instead, finished words fill length buckets in the proportions real words have, so the
phonotactics stay exactly as the model produced them and the traps cannot be spotted by shape.

**The one thing that must not happen is a real word in the pool.** A learner who says "I know this"
about a real word we are scoring as a trap is penalised for being right, and the false-alarm
correction silently inverts. Candidates are checked against ~1.8M Italian and ~3.8M English real
forms: both frequency corpora in full, the curated lists, and a dictionary word list **for every
language the learner knows** — an English word is no trap for someone studying Italian from
English.

### A filter cannot audit itself

The corpora alone passed `accurse`, `flanch` and `revender` into the English pool, and `unco`,
`pume` and `imino` into the Italian one. All are real; none appear in film subtitles or Wikipedia.
**Corpus absence is not evidence that a word does not exist**, and a filter always reports clean on
exactly the words it does not know.

So the stage ends with an independent check against `/usr/share/dict/words`, which is never part of
the filter. That is what caught all six. It is skipped with a note where the file is absent, and
the reproducible filter is unchanged by its presence.
