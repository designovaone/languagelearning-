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
| 5 | Pick primary sense — one-time AI pass | |
| 6 | Topic-cluster — one-time AI pass | |
| 7 | Sentences (Tatoeba) | |
| 8 | Audio (Kokoro-82M, local) | |
| 9 | **Load into the database** — `npm run corpus:load`, idempotent | ✅ |

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
