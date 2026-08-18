# Implementation plan

A self-hosted spaced-repetition language trainer. This document is the single source of truth for
what gets built and in what order. It supersedes all earlier planning notes.

Everything here is current and decided. Where something is genuinely undecided it appears in
[§16 Open questions](#16-open-questions) and nowhere else.

> **Keeping it true.** When the build departs from this document — a better mechanism, a hole found
> while implementing — **amend the affected section in the same session, in place.** Not in a
> changelog, not in a session note: this file is the only project record that survives a fresh
> clone, and it claims authority over every other document. A plan that describes something other
> than what was built will be faithfully implemented by the next person, and they will undo the fix.
> Milestones carry an **As built** table when the delivery differed from the spec above it.
> Gaps and deferred work live in [`ISSUES.md`](ISSUES.md) — this file says what gets built, that
> one says what is not yet true.

---

## Contents

1. [What this is](#1-what-this-is)
2. [Settled decisions](#2-settled-decisions)
3. [Architecture](#3-architecture)
4. [Data model](#4-data-model)
5. [Content pipeline](#5-content-pipeline)
6. [Assessment](#6-assessment)
7. [The study loop](#7-the-study-loop)
8. [AI tiers](#8-ai-tiers)
9. [Habit layer](#9-habit-layer)
10. [The nightly job](#10-the-nightly-job)
11. [Milestones](#11-milestones)
12. [Test suite](#12-test-suite)
13. [Configuration and deployment](#13-configuration-and-deployment)
14. [Verified constraints](#14-verified-constraints)
15. [Non-goals](#15-non-goals)
16. [Open questions](#16-open-questions)

---

## 1. What this is

A spaced-repetition trainer for a small group of learners, built to fix one specific failure of
commercial language apps: **words you already know come back far too often.**

The fix is [FSRS](https://github.com/open-spaced-repetition/ts-fsrs), an open scheduling algorithm
that decides when a card should return. It is a library, not a project — nothing about scheduling is
invented here.

The one structural idea worth stating: **FSRS can schedule more than words.** A grammar rule is a
card. When the nightly pass notices a recurring mistake, it becomes a card and gets scheduled like
any other. Commercial apps leave grammar implicit and unscheduled.

### Success criterion, written before there is anything to defend

> **Three months in:** are the learners still opening it most days, and does a session feel less
> wasteful than the app it replaced?
>
> - Yes to both → the premise held.
> - Sessions feel better, but usage drifted → the algorithm was right and the habit mechanics lost.
> - Used, but feels the same → the scheduling was never the real complaint.

All three are useful outcomes. The third is the most interesting to write about. It is only
embarrassing if the criterion is invented afterwards — hence writing it down now.

Two measurements make this checkable rather than a matter of opinion:

- **Fraction of shown cards already known**, from the review log. If the sin being escaped was
  re-showing known words, this app's version of that sin is a number.
- **Vocabulary size over time**, from the repeatable assessment (§6). A direct measure of whether
  anything is being learned.

### Current state

**M0 and M1 complete (2026-08-17).** Test harness, clock discipline, privacy guard and CI; full
schema live in Neon (Postgres 18, `eu-central-1`); invite-gated auth; i18n in `en` and `de`; GDPR
export and erasure; admin scripts for invites and password resets. 87 tests green.
**No content and no drill yet.** M2 (content pipeline) is next.

---

## 2. Settled decisions

Do not re-open these without a new reason.

| | Decision | Why |
|---|---|---|
| **Scheduling** | `ts-fsrs`, nothing hand-rolled | It is a maintained library and the algorithm is the whole point |
| **Card granularity** | FSRS state per **(user × word × exercise type)** | Recognition, production and listening are different skills. One shared state averages three numbers into one and weakens the premise. Expensive as a migration, free as a decision |
| **Grade signal** | Correctness **+ response latency** → four values. Raw signal always logged | FSRS grades on four values; auto-grading naturally yields two, leaving half the algorithm unused. See §7.3 |
| **Session delivery** | **Prefetch the whole session**, grade client-side, flush reviews in idempotent batches, FSRS runs server-side | Removing AI from the card path is not enough for an instant feel — a function call plus a DB round trip is still 150–400 ms. Also buys offline and resilience |
| **Content** | Built from **openly-licensed sources**, ~5,000 lemmas per language. **The word list and its order come from a curated learner vocabulary** (CEFR-J for English, NVdB for Italian); frequency data is a tie-breaker, not the source | Owning the content is the difference between a tool that can never leave the house and one that could. And words chosen by linguists for learners beat words ranked by how often they appear in film dialogue. See §5 |
| **Audio** | **Generated locally at build time by an Apache-2.0 open-weights TTS model** (Kokoro-82M), stored in blob storage | €0, output unambiguously ours, no provider terms to re-read. A cloud TTS API sells synthesis-per-request; building a permanent audio library is a use its terms do not automatically cover. See §5 |
| **Assessment** | Yes/No vocabulary test with pseudoword traps, plus measured recall | Validated method (LexTALE / LexITA). Works for any language, needs no course structure, and repeats as a progress measure. See §6 |
| **Auth** | Better Auth, **invite-gated** signup | Real accounts from day one, because the project may extend beyond the initial group. Invite gate because a public URL with open registration is an abuse surface |
| **i18n** | Per-user UI locale stored in the database. **No locale routing, no `proxy.ts`** | Keeps URLs stable and sidesteps the Next 16 middleware→proxy migration entirely |
| **Language axes** | UI locale, base language, target language kept **strictly separate** | A learner studying English from German needs German explanations. Conflating these is the most likely quiet failure |
| **Streak** | Personal streak each + a **shared "everyone studied" counter** + 2 freezes/month | A single shared streak that breaks when one person is ill punishes the wrong person |
| **Scheduling of jobs** | **GitHub Actions**, with the endpoint authoritative | Free, no new account. UTC-only and delayed runs are absorbed by the endpoint deciding. See §9.3 |
| **Region** | Database `aws-eu-central-1`, functions `fra1` | Latency for European users and EU data residency. Changing a database region later means dump, restore, downtime |
| **AI placement** | Three tiers by latency tolerance | See §8 |
| **Build order** | Drills first, AI coach second, with a two-week pause between | The AI features consume mistake data that does not exist on day one |

### Extensibility decisions (cheap now, migrations later)

Taken at M1 so no door closes:

1. `group_id` on profiles — the shared streak beyond two people
2. `source` + `license` on content tables — a future commercial build filters to what it may serve
3. `role` on profiles (`user` / `admin`) — an admin surface needs it, backfilling is unpleasant
4. `deleted_at` on profiles + a data-export query written at M1 — GDPR Art. 15 / 17
5. The nightly job written as a **resumable batch**, not one pass over all users
6. The region choice above

---

## 3. Architecture

```
Browser (installed PWA)            Vercel · fra1 · Node runtime        Postgres · eu-central-1
───────────────────────            ────────────────────────────        ───────────────────────
session start ─── 1 request ─────► GET  /api/study/session ──────────► queue builder
  ~60 cards held in memory                                              (due + new, gated)
  graded locally, zero network
  reviews buffered
  flushed every ~10 ─────────────► POST /api/study/reviews ───────────► ts-fsrs runs here
                                     (idempotency keys)                  → cards + reviews

typed answer ──────────────────── ► POST /api/study/grade ────────────► LLM, 2 s budget,
  (only for typed exercises)          fails soft to exact match          structured verdict

GitHub Actions 17:00 + 18:00 UTC ─► POST /api/cron/nudge    (secret) ─► warms DB, then web-push
GitHub Actions 03:00 UTC ────────► POST /api/cron/nightly   (secret) ─► buffer + analysis
```

**Principles**

- **The client never computes FSRS state.** It reports what happened; the server decides what it
  means. Keeps scheduling deterministic, replayable, and safe from a tampered client.
- **Nothing in the card path touches the network.** That is the entire instant-feel guarantee.
- **Cron endpoints are plain secret-authenticated routes**, not tied to any one scheduler.
- **No function in `lib/` calls `new Date()`.** Every pure function takes `now: Date`. Enforced by
  lint and a test.

### Code layout

```
app/
  (auth)/sign-in/  (auth)/sign-up/          invite-gated
  (app)/page.tsx                            dashboard: streak, due count, start
  (app)/study/                              the drill
  (app)/study/done/                         "done for today"
  (app)/assessment/                         onboarding + 3-monthly re-test
  (app)/settings/
  api/auth/[...all]/route.ts
  api/study/session/route.ts                GET  → prefetch
  api/study/reviews/route.ts                POST → batch flush, idempotent
  api/study/grade/route.ts                  POST → tier-2 grading
  api/audio/[wordId]/route.ts               blob → TTS-on-miss → SpeechSynthesis signal
  api/cron/{nudge,nightly}/route.ts         secret-gated
  api/me/export/route.ts                    GDPR
  manifest.ts
lib/
  time/clock.ts                             the only place new Date() is allowed
  db/{schema.ts,index.ts,migrations/}
  fsrs/{scheduler.ts,grade.ts,replay.ts,serde.ts}
  study/{queue.ts,normalize.ts,session.ts}
  assessment/{items.ts,pseudowords.ts,score.ts,seed.ts}
  streak/streak.ts
  ai/{client.ts,grade-answer.ts,nightly.ts,schema.ts,prompts/}
  audio/resolve.ts
  push/send.ts
  i18n/{request.ts,messages/{en,de}.json}
pipeline/                                   Python, run once, offline (§5)
scripts/load-corpus.ts                      pipeline artifacts → database
tests/                                      §12
.github/workflows/{ci.yml,nudge.yml,nightly.yml}
```

---

## 4. Data model

Postgres via Drizzle. Better Auth owns `user`, `session`, `account`, `verification` through its
Drizzle adapter — **do not add columns to those tables**, so upgrades stay boring. Everything else
hangs off `user.id`.

```
profiles            user_id PK→user, ui_locale, base_lang, timezone (IANA),
                    daily_new_limit, daily_review_limit, session_target_cards,
                    nudge_hour_local, group_id?, role, deleted_at?, created_at

courses             id, target_lang, base_lang, slug ('it-from-en'), name, source, license
bands               id, course_id, number, name, scheme
                    -- generic on purpose: band 1 is 'A1' (scheme 'cefr-j') for English and
                    -- 'Fondamentale' (scheme 'nvdb') for Italian. Different grading systems,
                    -- one table. A language with no curated list uses scheme 'frequency'.
words               id, course_id, band_id, band_source, freq_rank, lemma, pos, gender?,
                    translations jsonb, primary_sense, topic, cefr?,   -- cefr nullable, see §5
                    audio_asset_id?, source, license
                    -- band_source records where the grading came from, so a curated grading
                    -- can be swapped for frequency without rebuilding the deck
sentences           id, word_id, text, translation, audio_asset_id?, source, license

enrollments         user_id, course_id, enrolled_at, active     unique(user_id, course_id)

cards               id, user_id, course_id,
                    word_id?  grammar_item_id?  exercise_type,
                    -- ts-fsrs Card, one column per field, no JSON blob:
                    due timestamptz, stability real, difficulty real,
                    elapsed_days int, scheduled_days int, learning_steps int,
                    reps int, lapses int, state smallint, last_review timestamptz?,
                    suspended bool, activated_at?, created_at
                    unique(user_id, word_id, exercise_type)
                    index (user_id, due) where suspended = false      ← the hot query
                    check: exactly one of word_id / grammar_item_id

reviews             id, card_id, user_id, session_id,
                    -- raw signal, so the grade mapping stays reversible:
                    was_correct bool, duration_ms int, answer_given text?, hint_used bool,
                    -- derived:
                    rating smallint,
                    -- ts-fsrs before/after, so replay can be verified:
                    state_before, stability_before, difficulty_before, due_before,
                    stability_after, difficulty_after, scheduled_days, elapsed_days,
                    reviewed_at timestamptz, source ('drill'|'assessment'|'replay'),
                    idempotency_key text unique
                    index (user_id, reviewed_at)

answer_analysis     review_id PK, error_type, expected_form, given_form,
                    explanation_base_lang, model, confidence   ← what grammar mining reads

study_sessions      id, user_id, started_at, ended_at?, local_date, cards_done, seconds
daily_activity      user_id, local_date, cards_done, seconds     PK(user_id, local_date)
streak_freezes      id, user_id, local_date, granted_at

assessments         id, user_id, course_id, taken_at, estimated_size,
                    hit_rate, false_alarm_rate, corrected_score, band_curve jsonb
assessment_items    id, assessment_id, word_id?, pseudoword?, is_real,
                    answered_known bool, duration_ms

grammar_items       id, course_id, title, explanation jsonb, examples jsonb,
                    status ('pending'|'active'|'discarded'), source_review_ids int[],
                    created_by ('nightly'|'manual'), reviewed_at?, created_at

generated_content   id, word_id?, grammar_item_id?, exercise_type, payload jsonb,
                    model, valid_until?, created_at            ← the tier-1 buffer
push_subscriptions  id, user_id, endpoint unique, p256dh, auth, ua,
                    created_at, last_success_at, failure_count
nudge_log           user_id, local_date, sent_at              PK(user_id, local_date)
cron_runs           id, job, started_at, ok, note             ← powers the staleness warning
audio_assets        id, blob_url, bytes, voice, source, generated_at
invites             code PK, created_by, used_by?, used_at?, expires_at
ai_calls            id, user_id?, tier, model, prompt_tokens, completion_tokens,
                    cost_usd numeric, latency_ms, ok, created_at
```

**Notes that matter**

- `exercise_type` ∈ `recognition | production | listening | sentence | grammar`.
- **Gating:** `production` and `listening` cards are created suspended and activate only when that
  word's `recognition` card reaches `state = Review` with `stability >= 7`. Prevents a day-one flood.
- `elapsed_days` is deprecated in ts-fsrs 6.0. Keep the column (5.x still writes it); never read it
  in our own logic.
- Every timestamp is `timestamptz`. `local_date` is a plain `date` computed in the **user's**
  timezone, never the server's.
- `source` and `license` appear on every content table. A missing attribution is a licence breach,
  so the loader fails rather than guesses.

---

## 5. Content pipeline

**Target: the top ~5,000 lemmas per language.** That covers roughly 90–95% of running text and sits
comfortably past B2. Manageable in every dimension: storage, TTS cost, review volume.

### The word list is curated, not corpus-derived

**This is the spine of the whole deck, so it gets decided first and deliberately.**

An obvious approach is to rank words by how often they appear in a big pile of text — film
subtitles are the usual free source — and teach them in that order. It is cheap and it is what most
open-source flashcard projects do. It is also **not how anyone teaches a language.** Subtitle
frequency reflects film dialogue, not what a learner needs; it has no notion of level; and the top of
any such list is a run of function words (*the, of, and, to*) that teaches nothing.

Proper learner word lists exist, they are compiled by linguists for exactly this purpose, and for
both target languages there is an openly-available one. **They are the spine. Frequency becomes a
tie-breaker.**

| Target language | Curated list | Size | Grading | Licence |
|---|---|---|---|---|
| **English** | [CEFR-J Vocabulary Profile v1.5](https://github.com/openlanguageprofiles/olp-en-cefrj) + Octanove C1/C2 profile — Tono Laboratory, Tokyo University of Foreign Studies | ~7,000 | **A1 → C2** | CC BY-SA 4.0; explicitly *"research and commercial purposes with no charge, provided that you cite the dataset properly"* ✅ |
| **Italian** | [Nuovo vocabolario di base](https://github.com/pettarin/nvdb) (De Mauro & Chiari), **read from the published PDF** — see below | ~7,250 | **FO** fondamentale 2,020 → **AU** alto uso 3,000 → **AD** alta disponibilità 2,229 | Extraction released **public domain**; underlying selection is editorial — see caveat ⚠️ |

Both lists are ~7,000 entries, comfortably above the 5,000 target. **The curated lists alone are
enough**; frequency is no longer the source of the deck.

### The Italian bands exist only as typography

**Verified at M2, and it changes how stage 1 works.** The NVdB encodes its three usage bands as
*type style* — the article that accompanies the list says so plainly: fondamentale in bold, alto uso
in regular, alta disponibilità in italic. **Every plain-text extraction therefore loses the band**,
including the public-domain one this plan cites: `nvdb.full.txt` carries all 7,248 lemmas and zero
band markers.

Since the band *is* the learning order for Italian (§5, "what order to learn them in"), stage 1
reads the fonts back out of the published PDF rather than degrading to frequency. Recovered counts
land within a few percent of the figures the authors state, which is the check that it worked:
FO 2,020 against "circa duemila", AU 3,000 against "circa tremila", AD 2,229 against "circa 2.500".

The stage refuses to write its artifact if those counts drift or if too many styled headwords fail
to match an entry. That guard earned itself immediately: it caught the PDF's soft-hyphen line
breaks, where `acceca-` and `mento` are separate spans, which would otherwise have silently dropped
158 words out of their band and into the default one.

### Supporting sources

| Layer | Source | Licence | Commercial |
|---|---|---|---|
| Frequency *(tie-breaker + assessment sampling)* | [FrequencyWords](https://github.com/hermitdave/FrequencyWords) (OpenSubtitles 2018) blended with [wikipedia-word-frequency-clean](https://github.com/adno/wikipedia-word-frequency-clean) (Wikipedia 2022-10-20) | CC BY-SA 4.0 (content), MIT / BSD-3-Clause (code) | ✅ with attribution + share-alike |
| Translations, senses | [kaikki.org](https://kaikki.org/) / wiktextract (Wiktionary) | CC BY-SA + GFDL | ✅ with attribution + share-alike |
| Example sentences | [Tatoeba](https://tatoeba.org/en/downloads) | CC BY 2.0 FR, some CC0 | ✅ attribution only |
| Extra CEFR grading *(optional)* | [Kelly](https://ssharoff.github.io/kelly/) | **CC BY-NC-SA 2.0** | ❌ **non-commercial** |
| Audio *(chosen)* | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) open-weights TTS, run locally at build time | **Apache 2.0** | ✅ |
| Human audio *(optional, later)* | [Lingua Libre](https://lingualibre.org/) | CC BY-SA 4.0 | ✅ with attribution |
| Lemmatisation | spaCy models | MIT | ✅ |

### How the layers combine

1. **Which words exist** → the curated list for that language.
2. **What order to learn them in** → the curated band. Band 1 before band 2, always.
3. **Order *within* a band** → frequency rank, then topic cluster, so each session is coherent.
4. **Anything beyond the curated list** → frequency order, clearly marked as a lower tier.
5. **A language with no curated list** → the pipeline degrades to frequency-only. The architecture
   must support this, because the third language may not have an open graded list.

The existing `bands` table (§4) already carries this without change: band 1 is `A1` for English and
`Fondamentale` for Italian. The two languages use different grading systems and that is fine — the
schema stores a number and a name, not a fixed scale.

### Three rules that follow

1. **Nothing may depend on a non-commercial source.** Kelly is CC BY-NC-SA. Store its grading in a
   nullable annotation column if useful; never let ordering depend on it. A commercial build drops
   the column and loses nothing structural.
2. **The Italian list carries a caveat, and it is accepted.** The *extraction* is public domain and
   the underlying list is freely published and widely redistributed in Italian education — but the
   *selection* of which 7,000 words belong is editorial work, and in the EU a curated compilation can
   attract database rights. **Decision: a non-issue at this stage, and the build proceeds on it.**
   It becomes a question only if the project is ever sold, and it does not need answering before
   then. To keep that future cheap rather than to hedge now, the pipeline stores `band_source` per
   word, so Italian grading can be swapped for frequency ordering without rebuilding the deck.
3. **Share-alike is a commitment, not a problem.** The derived list is published under CC BY-SA with
   attribution; application code stays our own. The attribution file is generated by the pipeline,
   never hand-written.

### Stages

Each stage writes a checked-in intermediate artifact, so a re-run never repeats a paid step.

| | Stage | Notes |
|---|---|---|
| 1 | **Curated list** ✅ | CEFR-J + Octanove (English, 9,777 lemma/pos pairs A1–C2) / NVdB (Italian, 7,249 lemmas FO/AU/AD read from the PDF) → the word set and its band. This is the spine |
| 1b | **Frequency** ✅ | Blend FrequencyWords (OpenSubtitles, spoken) with wikipedia-word-frequency-clean (written) by the **geometric** mean of the two ranks — see "Why the geometric mean" below. Used to order *within* a band, to top up beyond the curated list, and for assessment sampling — **not** as the source of the deck |
| 2 | **Lemmatise** | spaCy. Collapse *sono / è / siamo* into one `essere` with inflections attached. **This is the genuinely fiddly step** — expect a day on Italian clitics and German separable verbs |
| 3 | **Filter** | Drop proper nouns, numerals, fragments, and a profanity blocklist. Much lighter than before: a curated list arrives clean |
| 4 | **Translate** | kaikki.org → senses, part of speech, gender |
| 5 | **Pick primary sense** | One-time AI pass, ~€1–3. Two jobs, not one — see below. Wiktionary carries many senses, *and* for Italian it carries definitions rather than translations |
| 6 | **Topic-cluster** | One-time AI pass grouping each band into coherent sets ("food", "travel"). Now a refinement rather than a rescue — the curated band already provides pedagogical order |
| 7 | **Sentences** | Tatoeba, 2–3 per word, filtered to sentences whose other words are already in-band. This is also the sentence-level material §8 needs |
| 8 | **Audio** | Kokoro-82M locally, for every word and every sentence. **Listen to a 20-word sample first** |
| 9 | **Load** | → courses / bands / words / sentences, with attribution rows |

Stages 5 and 6 are the first genuinely good use of the AI budget, run once, and cost a few euros
together. Their output is **spot-checked by hand** — 50 random words — before loading, not trusted.

### Why the geometric mean — amended at build time

This section originally said stage 1b should **average the ranks**. Measured on the real corpora,
the plain average is the wrong average, and the build uses the **geometric** mean instead.

Rank distributions are heavy-tailed, so an arithmetic mean is dominated by whichever corpus rates a
word *worst*. A word essential in one register and near-absent from the other gets buried — which
is the single thing a two-register blend exists to prevent. In the Italian Fondamentale band:

| | subtitles | wikipedia | geometric | arithmetic |
|---|---|---|---|---|
| `ciao` | #153 | #15,068 | **683** | 1,611 |
| `ecco` | #188 | #7,251 | **535** | 1,195 |
| `bosco` ("woods") | #2,719 | #3,026 | 1,143 | **986** |

The arithmetic mean teaches *bosco* before *ciao*. The geometric mean does not, because it rewards
a word that is very common in **at least one** register.

Two smaller rules, each settled by looking at the data rather than by choosing a constant:

- **A word in only one corpus is ranked by that corpus, with no penalty.** The single-corpus words
  are either tokenisation artifacts (the Wikipedia list treats `-` and `'` as word-breaking, so
  `e-mail`, `ping-pong` and `o'clock` can never appear in it) or already ranked poorly where they
  do appear (`altoatesino` at wiki #59,598). Neither case wants a penalty.
- **A multi-word entry takes the rank of its rarest component.** A phrase cannot be more common
  than the least common word in it. This covers the ~150 CEFR-J phrases (`bus stop`).

**As built:** 100.0% of Italian and 99.8% of English curated lemmas carry a rank. The stage refuses
to write if coverage drops below 95%, if fewer than 90% of ranks used both corpora, or if any of a
short canary list (`essere`, `casa`, `ciao`, `the`, `water`, …) falls outside the top 5,000.

**Known consequence, accepted for now:** ordering band 1 by frequency puts function words at the
head — Italian opens `e, di, il, la, che`. This is the failure this section warns about above, and
it survives inside a band because band FO *contains* function words. It is not fixed here because
the assessment (§6) seeds them as known before the drill ever runs (M3 precedes M4). Revisit with
real data if it turns out to matter.

### Stage 5 has two jobs, not one — amended at build time

This section described stage 5 as choosing among senses. Measured on the stage 4 artifacts, that
is only half the work, and the two courses need different halves:

| | needs a choice (>1 option) | needs a cleanup (first is a gloss) |
|---|---|---|
| Italian → English | 68.8% | **56.3%** |
| English → German | 79.4% | 0.2% |

The English Wiktionary's *German translations* are clean words (`Betrug`, `Täuschung`). Its
*English glosses of Italian words* are definitions: `crescere` → "to grow, to increase, to expand",
`atmosfera` → "atmosphere (all meanings), air". Choosing among definitions still leaves a
definition on the card.

So the stage does the cheap job first, deterministically and for free: strip parentheticals, take
the first comma- or semicolon-separated equivalent. That alone turns "atmosphere (all meanings),
air" into "atmosphere". Only where a real choice survives does the model see the row — which
shortens the prompt, cuts the cost, and means a missing API key still improves the deck.

**The model may choose or extract; it may not invent.** An answer is accepted if it *is* one of the
candidates, or if it appears inside one on whole-word boundaries. The second rule was added after
the first run: Wiktionary buries the real translation inside a definition often enough that exact
matching alone put "any member of the Cygnus taxonomic genus" on the swan card, and 54 Italian rows
fell back for that reason. Either rule keeps the guarantee that matters — every word came from the
source text. Anything else is discarded, the row falls back to candidate 1, and the fallback rate
is reported; the stage refuses to write above 10%. A translation engine that quietly substitutes a
plausible word is the worst failure available here, because its output is indistinguishable from
success.

**As run, 2026-08-18.** `google/gemini-2.5-flash-lite`, 14,904 cards, 12,346 decisions, **4
fallbacks (0.03%)**, **$0.07** total against the €1–3 estimate. 100 hand-checked words (50 per
language) came back roughly 95% good; the residue is recorded in `ISSUES.md` rather than chased,
since the remaining errors are Wiktionary phrasing rather than wrong senses.

`{lang}-05-primary.jsonl` is both output and cache, checked in, and records the `options` each row
was decided from, so an upstream stage 4 change re-opens only the affected rows. `--dry-run` never
writes: an artifact full of fallbacks looks finished and is not.

### Audio: generated locally, from an open-weights model

**Decision: run Kokoro-82M locally at build time.** Not a cloud TTS API.

The reason is the same reason the content itself is no longer borrowed. A commercial TTS API sells
you *synthesis*, and its terms typically cover generating audio on the fly for one listener per
request. **Building a permanent library of 10,000 files, storing it, and serving it to users
indefinitely is a different use, and it is not automatically covered** — it is the pattern the terms
tend to single out. Swapping a dependency on one company's content terms for a dependency on
another company's audio terms would be the same mistake with a nicer invoice.

Kokoro-82M is **Apache 2.0** — model and weights — with 54 voices across 8–9 languages, including
Italian and both American and British English. At 82M parameters it runs on a laptop CPU. So:

- **Cost: €0.** Not "cheap." Zero, and no per-character metering to think about again.
- **Output is unambiguously ours**, under the most permissive licence available short of hiring a
  voice actor. (Apache 2.0 covers the released model. Training-data provenance is an open industry
  question for every TTS model, including the paid ones — this is the strongest available position,
  not a legal opinion.)
- No account, no key, no rate limit, no terms to re-read when the project changes shape.

**Quality gate before generating at scale:** Italian has only 2 voices in this model. Generate ~20
words and ~5 sentences per language and **listen to them** before committing to 10,000 files. If
Italian is not good enough, the fallbacks below apply — but decide by ear, not by spec sheet.

**Fallback stack**, so a listening exercise can never render without a sound path:

1. Generated file in blob storage (~150 MB for the full library)
2. [Lingua Libre](https://lingualibre.org/) human recordings where they exist — CC BY-SA 4.0, real
   native speakers. A good later quality upgrade for high-frequency words, not a foundation, since
   coverage is uneven
3. Browser `SpeechSynthesis` on the device — no storage, no provider, no licence exposure at all

### Known weakness

Largely resolved by using curated lists — the words and their order now come from linguists who
compile vocabulary for learners, not from film dialogue. Two things still worth watching:

- **The two languages use different grading systems** (CEFR levels vs usage bands). Comparable in
  spirit, not identical in construction. Do not present them as the same scale to the learner.
- **The topic-clustering pass is still unproven.** It now improves an already-sensible order rather
  than rescuing a bad one, so the downside if it disappoints is small.

An admin review queue for the first ~500 words stays in the plan regardless.

---

## 6. Assessment

Replaces the idea of asking a learner "which unit are you on". Works for any language, needs no
course structure, and repeats as a progress measure.

The method is [LexTALE](https://link.springer.com/article/10.3758/s13428-011-0146-0), with a
validated Italian adaptation (LexITA).

### Part A — Yes/No test with pseudoword traps · 3–5 minutes

Show a word. Two buttons: **"I know this"** / **"I don't."**

- ~40 real words sampled across frequency bands
- ~20 **pseudowords** — invented forms that obey the language's spelling rules but mean nothing

**The pseudowords are the mechanism.** Self-report is the fastest possible measurement and the least
trustworthy. Rather than replacing it with something slower, the false-alarm rate measures the
over-claiming directly and the score subtracts it:

```
corrected = hits/realWords − falseAlarms/pseudowords
```

A learner who taps "I know this" on everything scores near zero, not near perfect.

### Part B — Measured recall · ~15 items

Real recall items sampled around the boundary Part A estimated. Converts self-report into measured
accuracy and yields a **probability-of-known curve across frequency bands** rather than a single
cutoff.

### Part C — Seed FSRS from the curve

| P(known) | Seeded as |
|---|---|
| High | `recognition` card in `Review`, stability scaled to confidence (~3–21 days) |
| Middle (the fuzzy boundary) | `New`, prioritised in the queue |
| Low | `New`, ordered by frequency |

**Never mark a word known that was never tested.** Seed low: a too-easy card is pushed out by FSRS
within 2–3 reviews, but a never-shown unknown word stays invisible indefinitely.

### The size estimate is a curve fit, not a band average — decided at build time

The obvious estimator is the share of known words in each band multiplied by the band's size. It is
unbiased and **too noisy to use**: Italian has three bands, so fifty real items become three
proportions of roughly seventeen answers each, and the resulting estimate carries a standard
deviation near 300 words. Band 2 alone contributes ±390.

That is a resolution limit, not a tuning problem — every word inside a band scores identically, so
3,000 words of `alto uso` get one number from seventeen answers.

Instead the answers are placed on their **exact frequency rank** (stage 1b) and a two-parameter
logistic is fitted:

    P(known | rank) = 1 / (1 + exp((ln rank − mu) / s))

Fifty observations against two parameters, rather than three proportions against seventeen
observations each. Measured over simulated learners this cut the standard deviation from ~300 to
~260 and, more importantly, removed a growing negative bias for strong learners (−546 words at a
true size of 6,500) once a fixed 6% lapse rate was written into the likelihood.

**The learner is shown a range, not a number.** The instrument resolves to about ±550 words at two
standard deviations, at every level. A bare figure would claim a precision the measurement does not
have.

### Seeding reads the fitted curve, not the band average — corrected after the first honest sitting

Part C originally seeded from the **band** curve. The first real sitting exposed what that means in
practice: a learner estimated at **4,520 known words was seeded zero cards.**

Italian has three bands of 2,000–3,000 words, so a band average only clears the 0.8 bar for a
near-fluent learner. Everyone else gets an estimate with nothing behind it — and the failure is
silent, because the number on screen is right. The estimate and the seeding were computed from
different models and nothing compared them.

Seeding now uses each word's own P(known) from the fitted frequency curve (§6, above), which is the
better estimator and was already being computed for the size figure. The same sitting now seeds
1,219 cards as known, 4,381 as prioritised-new at the boundary, and 1,483 as new.

The gap between 4,520 estimated and 1,219 seeded is deliberate, and it is the asymmetry again: a
word only becomes a `Review` card at P ≥ 0.8. The rest start `New`, appear early, and FSRS pushes
them out within two or three reviews if the learner does know them.

### Seeded cards are spread across the interval

P(known) is a band-level number, so every word in a band shares a stability, and the obvious
`due = now + stability` gives one date. Run live, that seeded **4,906 cards all due on the same
day** three weeks out. Every unit test passed — they asserted `due > now`, which was true of all
4,906.

Seeded cards are therefore spread across the window, ordered by frequency rank: the rarest words
come back first, because they are the ones a band-level estimate is least likely to have got right.
The same learner now sees ~245 cards a day rather than 4,906 in one sitting.

### Part D — Re-assessment every ~3 months · 20 items

Turns onboarding into a progress instrument, and provides the vocabulary-size measurement the
success criterion in §1 needs.

### A pseudoword must not be a near-neighbour of a real word

**Found from the first real sitting, not from a test.** The first learner produced a 30% false-alarm
rate — six of twenty traps claimed. Inspecting the pool explained it: **20% of candidates sat one
edit from a word in the learner's own deck.** `affetare` beside `affettare`, `appunte` beside
`appunto`, `atimo` beside `attimo`.

Those are not traps. A fluent reader does not read letter by letter, so recognising `affetare` as a
word they know is correct reading, not over-claiming — and a trigram model trained on real words
produces such near-neighbours by construction.

The damage is worse than a wasted item, because a false alarm is *subtracted*. A confusable trap
does not merely fail to measure over-claiming; it **actively understates how much the learner
knows**. The correction designed to stop over-claiming was penalising competence.

So a candidate is rejected if any word among the ~20,000 most frequent, plus the whole curated deck,
is one insertion, deletion or substitution away. That is 0% of the pool now, against 20% before, and
it is asserted over the output rather than trusted from the generation loop.

### Pseudowords must be generated, not borrowed

Published item lists are fixed, so they can be taken exactly once before being memorised — useless
for Part D. Generate with a character bigram/trigram model over the frequency list (the approach
behind [Wuggy](https://link.springer.com/article/10.3758/BRM.42.3.627)), then **validate every
candidate against the full Wiktionary lemma list** so no accidental real word slips through.

Everyone takes the assessment, including the first learners. Prior experience simply shows up as a
high estimate.

---

## 7. The study loop

### 7.1 Queue construction

Server-side, on `GET /api/study/session`:

- Due cards where `due <= now`, ordered `due asc`, capped at `daily_review_limit`
- Plus new cards in frequency order, capped at `daily_new_limit`
- Interleaved so no word appears twice within 5 cards
- Gating respected (§4)
- Session target ~60 cards or ~10 minutes, whichever comes first

### 7.2 "Done for today"

**When nothing is due, the app says so and offers no grind.**

This is a designed screen with the day's numbers on it, not an empty state. It is the moment the
learner sees the core complaint being fixed, and a commercial app whose business needs the session
to continue structurally cannot offer it.

### 7.3 Grading

Client-side for `recognition`, `production` and `listening`: normalized exact match against the
accepted translation list (case, accents, punctuation and articles handled; multi-sense lists like
`away, for, per, at, on, to, in, into` all accepted).

The FSRS grade is derived, never asked for:

| Signal | Grade |
|---|---|
| Wrong | `Again` |
| Right, fast (below ~40% of the learner's rolling median for that exercise type) | `Easy` |
| Right, normal | `Good` |
| Right but slow, or a hint was used | `Hard` |

Guards: per-user, per-exercise-type rolling medians; outliers beyond 3× median clamped; **latency
alone never produces `Again`.**

**The insurance that makes this safe:** every review stores `was_correct`, `duration_ms`,
`answer_given`, `hint_used` and `reviewed_at`. The grade is therefore a *pure function* of stored
raw signal. If the mapping proves wrong later, replay the entire log through a new mapping and
recompute every card. Four columns turn an irreversible modelling choice into a re-run.

### 7.4 Flush

Client buffers reviews and flushes every ~10 cards, on `visibilitychange`, and at session end. Each
review carries an idempotency key. The server runs `ts-fsrs` and writes `cards` + `reviews`
transactionally.

Cards answered wrong are re-queued locally within the session (FSRS learning steps want them back
within minutes); the server's computation remains the truth.

**Invariant:** replaying a session's review log server-side yields the same final card states
regardless of how flushes were batched. This is tested directly.

---

## 8. AI tiers

Split by how long a human will tolerate waiting.

| Tier | Budget | What runs there |
|---|---|---|
| **1 — no AI** | instant | FSRS picks the card (sub-millisecond). Content pre-generated. Exact-match grading |
| **2 — live** | 1–2 s | Grading typed answers, "why was I wrong?", conversation practice |
| **3 — nightly** | irrelevant | Buffer top-up and mistake analysis |

**There is deliberately no AI call in the path of a normal card** — not for cost, but for waiting.
At 1.5 s per call and 150 cards, that is roughly four minutes of spinner per session plus 150 chances
for a timeout to break the drill.

### Tier 2 requirements

- Structured output, zod-validated, **temperature 0**
- 2 s timeout, one retry
- **Fails soft:** any timeout, malformed JSON, or schema mismatch falls back to exact-match grading.
  A model failure must never break the drill
- Explanations written in the learner's **base language** — a prompt constraint, easy to forget
  because it lives in a prompt rather than a string file
- Verdict written to `answer_analysis` with `error_type`, `expected_form`, `given_form`
- Every call logged to `ai_calls` with tokens, cost and latency
- **Determinism matters:** the same wrong answer graded differently on different days feeds FSRS
  noisy data, which defeats the reason for building this. Tested (§12)

### Sentence-level exercises are required in the first phase

A word→translation drill records "got this word wrong." It cannot record *"used the wrong auxiliary
verb"* — that is a sentence-level event. Run the nightly grammar analysis against word-level misses
and it will produce fluent, plausible, entirely generic advice, because nothing else is available to
it.

**So typed exercises must sometimes present a short sentence, and the review log must store the
learner's exact text plus a structured verdict.** The nightly job then becomes a query rather than a
miracle. This is the dependency that decides whether the project's one novel claim is real.

### Per-user AI budget

A daily cap per user, enforced before the call. Without it, one enthusiastic learner plus a retry
loop can run up the bill unsupervised. Required before the first user outside the initial group.

---

## 9. Habit layer

The real risk is habit, not features. If it does not feel like five easy minutes, the better
algorithm is worthless because nobody opens it.

### 9.1 Streak

- A **personal streak** per learner, computed from `daily_activity` in that learner's timezone
- A **shared counter**: days on which everyone in the group studied
- **2 freezes per month**, applied automatically

Nobody can break someone else's number. A single shared streak that breaks when one person is ill
is a mechanic that ends projects socially rather than technically.

### 9.2 Installable app

Both target devices are iOS, which makes this non-negotiable: **web push on iOS only works from an
app installed to the home screen.** There is no browser-tab fallback.

- `app/manifest.ts`, icons, service worker
- iOS gives no `beforeinstallprompt`, so the install cannot be automated — the app must *show*
  Share → Add to Home Screen instructions, in the user's UI language
- The push permission prompt must be triggered by a tap **inside the installed app**, after the
  first successful session, when the value is already visible
- **Design floor: 375 × 812 CSS px.** If a drill card works there it works everywhere

### 9.3 The nudge

Runs on GitHub Actions, with the **endpoint** authoritative rather than the schedule. This absorbs
both of GitHub's limitations:

- **UTC-only, imprecise runs.** The workflow fires at **17:00 and 18:00 UTC** — the two UTC hours
  that can contain the target local hour across summer and winter. `/api/cron/nudge` checks, per
  user, whether it is currently their `nudge_hour_local` *and* whether `nudge_log(user_id,
  local_date)` already has a row. Wrong hour → no-op. Already sent → no-op. The schedule may fire
  twice, early or late; each user still gets exactly one notification at roughly the right time.
- **Scheduled workflows are disabled after 60 days of repo inactivity.** The nudge would stop
  silently — precisely the invisible-failure pattern to avoid. Two mitigations: the nightly workflow
  pushes a dated heartbeat, **and** `cron_runs` records every run so the dashboard can warn when the
  last one is more than 36 hours old. The second matters more: it makes the failure visible from
  inside the app.

The database warm-up is the first step of the nudge workflow, a few minutes ahead of the send — the
free database tier suspends after 5 minutes idle, and that cold start would otherwise land on the
first card of the day.

---

## 10. The nightly job

**Two jobs, in this order.** Written as a resumable batch with a cursor, processing N users per
invocation — not one pass over everything.

1. **Buffer top-up.** Generate content only for what FSRS says is due in the next 48 hours, plus a
   margin. Not everything up front: most of a full generation would be for words that will not be
   reached for two years, and tuning the prompt afterwards would mean regenerating all of it.
2. **Mistake analysis.** Read `answer_analysis` for the last 14 days, cluster by `error_type`,
   propose grammar items.

**Everything generated lands in `pending`.** It surfaces in the app with keep/discard, and the
discard rate is tracked and visible. If eight in ten generated cards are discarded, the feature is
not working and that is known within days rather than months. It also produces a labelled dataset
for improving the prompt.

This is the one feature nobody else has and the one most likely to fail invisibly: a generated card
that is subtly wrong looks exactly like one that is right.

---

## 11. Milestones

Roughly 13 focused days, plus a two-week pause. **The stop after M7 is the important line** —
everything up to it is a complete, usable replacement; everything after needs real mistakes to exist
first.

### M0 — Harness before features · ½ day ✅ **done 2026-08-17**

The test suite goes in before the first feature, or it never gets written.

- Commit the scaffold; rename the package; fix `.gitignore`'s bare `*.csv` to `/seed/` plus
  `!tests/fixtures/*.csv` so test fixtures are not silently swallowed
- Install the test stack (§12), add scripts, configure vitest
- `lib/time/clock.ts` + the lint rule banning `new Date()` elsewhere
- CI: typecheck, lint, unit, db, privacy — no secrets needed
- **Exit:** `npm test` green, privacy guard active

**As built**, with the amendments folded into §12 and §13 above rather than left as a footnote:

| | |
|---|---|
| `test:tz` | selects `*.tz.test.ts`, fails on an empty set (§12 rule 2) |
| Privacy guard | scans untracked-not-ignored files too (§12 Layer 6) |
| Guards | each proves it still detects what it claims (§12 rule 3) |
| `vite-tsconfig-paths` | dropped; Vite resolves tsconfig paths natively |
| `db:*`, `corpus:*` | deferred to M1/M2 (§13) |
| PGlite | verified to carry full tzdata — both 2026 European DST transitions asserted. Without it every timezone test below would pass while measuring nothing |
| `lib/time/clock.ts` | `Clock`, `systemClock`, `fixedClock`, `steppingClock` |

### M1 — Schema, auth, i18n · 1 day ✅ **done 2026-08-17**

- **Create the database in `aws-eu-central-1`; set functions to `fra1`.** Two minutes now, a
  dump/restore with downtime later
- Full schema (§4) including the six extensibility columns, migrations checked in
- Better Auth + Drizzle adapter, email/password, invite-gated
- `scripts/reset-password.ts` — the manual reset mechanism, since there is no email provider yet
- next-intl with no locale routing; `en.json` and `de.json` created together from the first string
- `/api/me/export` and a hard-delete path
- **Exit:** migrations apply from empty; signup without a valid invite is refused; both locales have
  identical key sets; logged-out `/study` redirects; the reset script works end to end

**As built.** All five exit criteria are covered by tests, plus the following:

| | |
|---|---|
| **Driver: `neon-serverless`, not `neon-http`** | The HTTP driver *throws* `No transactions support in neon-http driver`. §7.4 needs the review flush transactional, so the HTTP driver would have passed every M1 query and failed at M4 |
| Better Auth tables | Transcribed from the library's own `getAuthTables()` into a separate `lib/db/auth-schema.ts`, so "do not add columns" is a file boundary rather than a comment. Timestamps are `timestamptz` and defaults are SQL-side `defaultNow()` — the generator's `$defaultFn` form reads the wall clock in application code |
| `createAuth(db, { clock, baseURL, secret })` | Injectable, so the invite gate is tested against in-process Postgres with a fixed clock instead of only in production |
| Invite gate | Rejects missing / unknown / used / expired codes with **one identical message**, so the endpoint is not an oracle for guessing valid codes. Consumed atomically (`used_by is null` guard), so a race cannot admit two people on one code |
| Auth gate placement | `app/(app)/layout.tsx` calls `requireUser()`, so a new page under that group cannot forget it. A test asserts the layout still does, and that every API route uses `requireApiUser` or a cron secret |
| `scripts/create-invite.ts` | **Added** — not in the plan, but signup is invite-gated and nothing could issue one. Unambiguous alphabet (no O/0, I/1/L), because codes get read aloud |
| `scripts/reset-password.ts` | Reads the password from stdin, never argv, so it stays out of shell history and `ps`. Uses `auth.$context.password.hash` + `internalAdapter.updatePassword` |
| GDPR | `lib/gdpr/export.ts` exports its table lists so a test can compare them against the live schema. An export that omits a table downloads fine and is wrong — no end-to-end test of a working program would catch it |
| Region | `vercel.json` → `regions: ["fra1"]` |
| `typecheck` | Runs `next typegen` first (see §13) |

### M2 — Content pipeline · 2 days

Stages 1–9 (§5), each writing a checked-in artifact. Attribution file generated, not hand-written.

- **Exit:** 5,000 lemmas per language, each with translations, ≥2 sentences, a topic label, a
  frequency band and audio; 50 randomly chosen senses hand-checked and correct; re-running costs
  €0 in AI

### M3 — Assessment · 1.5 days ✅ **Parts A and C done 2026-08-18**

Parts A–D (§6), plus `scripts/reset-learner.ts`.

**As built.** Part A (yes/no with pseudoword traps) and Part C (seed FSRS) ship together with the
reset script, the API, and the screen. Part B (measured recall) and Part D (re-assessment) are
written into the scoring module (`calibration`, `calibrate`) but have no UI yet — Part A plus the
frequency fit already carries the estimate, and Part B is a precision refinement rather than a
prerequisite. Recorded in `ISSUES.md`.

**The reset script ships with M3, not after it.** A real assessment run seeds FSRS state, so the
second practice run lands on top of the first and neither can be judged. Without a way back to
zero, the assessment can be tested exactly once per learner — and the cheapest validity check
available to a person is *running it twice and seeing whether the two estimates agree*. Same shape
as `reset-password.ts`: local, admin-only, reads the confirmation from stdin.

Scope: clear `cards`, `reviews`, `assessments`, `daily_activity` and streak rows for one user,
leaving the account, profile and enrollment alone. `--dry-run` prints the counts it would delete.

- **Exit, as amended:** 1,199 Italian and 1,200 English pseudowords contain zero real words —
  checked against ~1.8M/3.8M real forms *and* against an independent dictionary that is not part of
  the filter; monotonicity holds; **a learner who taps "I know this" on everything scores 0 and is
  seeded 0 cards** (verified against the live database, not only in tests); the reset script returns
  a learner to a state where re-assessment behaves identically to a first one.

  **The ±15% criterion was amended after measuring it.** It asked for ±15% at every level; that is
  unreachable in a four-minute test, and the reason is structural rather than a tuning failure. The
  estimate carries a standard deviation of about 260 words that barely moves with true size, because
  the deck holds 7,000 words and each answer is one bit — so ±15% of 800 words is ±120, inside the
  noise floor. Raising the test to 120 items still only reached 89% overall. The criterion now reads:
  **within ±15% for learners above ~2,500 words in ≥90% of 500 runs** (measured: 94.7%), plus a flat
  ±700-word bound that holds at every level including beginners, and bias under 200 words everywhere.
  Both first learners sit well above 2,500.

### M4 — The drill loop · 2 days ← the core

Queue, prefetch, client grading, idempotent flush, server-side FSRS, review log, `daily_activity`,
"done for today".

- **Exit:** the replay invariant passes; double-flushing a batch changes nothing; **card-to-card
  issues zero network requests**

### M5 — Listening · ½ day

Audio resolution: blob hit → serve; miss → generate and store; failure → signal the client to use
`SpeechSynthesis`.

- **Exit:** all three branches tested; no listening exercise can render without a sound path

### M6 — Typed answers + tier 2 · 1.5 days

Including **sentence-level exercises** (§8). Structured verdicts to `answer_analysis`. `ai_calls`
logging from the first call. Per-user budget.

- **Exit:** the 40-case grading eval hits target; a forced timeout still advances the drill; a
  malformed response never reaches the user

### M7 — Streak, PWA, nudge · 1.5 days

§9 in full.

**Nudge reliability is deliberately phased** (decided 2026-08-18). Delivery is *checked by hand*
for the first weeks rather than monitored — with two learners, a missed reminder is noticed the
same day and costs nothing. The engineering that makes it self-reporting (the `cron_runs`
staleness warning and the heartbeat in §9.3) still ships with M7, because both are cheap and the
failure they catch is silent. What is deferred is anything beyond that: delivery receipts,
retries, per-device failure tracking. **Revisit before a third learner joins** — manual checking
does not survive people whose missed reminders nobody else sees.

- **Exit:** both phones show a notification at the right local time on a DST-shifted date; firing
  the endpoint four times in one day sends exactly one notification per user; streak tests pass
  under three server timezones

### ⛔ STOP — use it daily for two weeks

Nothing built after this can be evaluated without real mistake data. During the pause the only work
is bug fixes and reading the numbers from §1.

### M8 — Nightly job · 1 day

§10, built on two weeks of real data.

- **Exit:** the relevance test passes — every generated item references a word or form actually
  present in the input log

### M9 — Grammar cards · 1 day

`pending` items surface with keep/discard; kept ones become `grammar` cards on FSRS; discard rate
tracked and visible.

- **Exit:** a discarded item never becomes a card; discard rate is queryable

---

## 12. Test suite

**Principle: test what is expensive to get wrong and cheap to check.** That is the grade mapping,
the queue, the streak, timezone handling, assessment scoring, and the AI failure paths.

**Not tested:** `ts-fsrs` itself, UI snapshots, Better Auth internals, Drizzle's SQL generation.

### Stack

`vitest` · `@vitejs/plugin-react` · `jsdom` · `@testing-library/react` · `@testing-library/dom` ·
`@vitest/coverage-v8` · `@electric-sql/pglite` · `fast-check` · `@playwright/test`

Config lives in `vitest.config.mts`. Path aliases come from `resolve.tsconfigPaths: true` — Vite
resolves `tsconfig.json` paths natively, so no `vite-tsconfig-paths` plugin.

### Layer 1 — Pure logic

| File | Proves |
|---|---|
| `unit/fsrs/grade-mapping.test.ts` | Every `(was_correct, duration_ms, hint_used)` maps to exactly one grade; wrong is always `Again`; latency alone never produces `Again`; thresholds track the learner's median; nonsense latencies are clamped |
| `unit/fsrs/serde.test.ts` | ts-fsrs `Card` ⇄ DB columns is lossless both ways, including `last_review = undefined` and all four states |
| **`unit/fsrs/replay.test.ts`** | **The centrepiece.** 500 fixture reviews replayed reproduce stored card states exactly — and identically at flush batch sizes 1, 7 and 500. This is what makes the grade mapping reversible and the batching safe |
| `unit/study/normalize.test.ts` | Case, accents, punctuation, articles and multi-sense lists all grade correctly. Property test: `normalize` is idempotent |
| `unit/study/queue.test.ts` | Caps respected; no duplicates; no word twice within 5; suspended never returned; gating honoured; deterministic given `(user, now, seed)`; **empty when nothing is due** |
| `unit/streak/streak.test.ts` | Streaks across gaps, freezes, both DST transitions, and a learner whose local day differs from the server's. Shared counter correct |
| `unit/assessment/score.test.ts` | The false-alarm correction: tapping "know it" on everything scores near zero; a careful learner is not penalised; monotonic |
| `unit/assessment/pseudowords.test.ts` | **1,000 candidates contain zero real words**, checked against the full Wiktionary lemma list. Forms obey the target language's spelling patterns. Two runs never repeat an item |
| `unit/assessment/seed.test.ts` | No untested word is ever marked known; simulated learners estimated within ±15% in ≥90% of 500 runs |
| `unit/corpus/lemmatise.test.ts` | Italian clitics and German separable verbs collapse to the right lemma |
| `unit/i18n/messages.test.ts` | Both locale files have identical key sets — catches a half-translated UI early |
| `unit/ai/prompt.test.ts` | The base language is always in the prompt; no email, name or id ever is |
| `unit/ai/parse.test.ts` | Truncated JSON, wrong schema, empty body and an HTML error page each fall back to exact match and never throw |

Property tests via `fast-check` on `normalize`, `queue` and assessment scoring.

### Layer 2 — Database (PGlite, real Postgres in-process)

No Docker, no network, safe in CI on a public repo.

| File | Proves |
|---|---|
| `db/migrations.test.ts` | Migrations apply from empty; applying twice is a no-op |
| `db/cards.repo.test.ts` | The due-card query uses the partial index; the unique constraint is enforced; the one-of check fires |
| `db/reviews.flush.test.ts` | Flushes are transactional; a repeated idempotency key writes nothing; concurrent flushes of the same batch produce one row |
| `db/activity.test.ts` | `daily_activity` rolls into the right `local_date` for a European learner when the server runs UTC |
| `db/import-corpus.test.ts` | The fixture corpus loads idempotently; **every source's attribution row is present** — a missing attribution is a licence breach and fails the build |

PGlite is real Postgres but not the production host: it does not exercise the serverless driver,
connection limits or cold starts. One manual smoke test against a real dev branch covers that.

### Layer 3 — API contract

| File | Proves |
|---|---|
| `api/auth-gate.test.ts` | Every `/api/study/*` route rejects unauthenticated requests; signup without a valid invite is refused; a used invite cannot be reused |
| `api/cron-auth.test.ts` | `/api/cron/*` returns 401 without the secret, with a wrong secret, and with no header. Timing-safe comparison |
| `api/cron-nudge.test.ts` | Firing at 17:00 and 18:00 UTC on a summer date and a winter date sends exactly one push per user at the right local hour on both; four firings send one; 03:00 UTC sends none |
| `api/session.test.ts` | The prefetch response contains everything needed to render a card with no further request — asserted field by field |
| `api/validation.test.ts` | Malformed review batches rejected; a review for someone else's card refused |

### Layer 4 — AI quality

**In CI, no network:** the mocked tests in Layer 1.

**Opt-in, `npm run eval` (real model, costs cents):**

- `eval/grade-answers.eval.ts` — 40 labelled typed answers (accepted synonyms, typos, wrong gender,
  wrong tense, right meaning wrong word, blank, gibberish). **Target ≥95% agreement on the 30
  unambiguous cases**, every disagreement printed
- **Determinism check** — the same 10 answers, 3 runs at temperature 0, identical verdicts
- `eval/nightly-relevance.eval.ts` — run the nightly job against a fixture log, then assert
  **mechanically** that every generated item references a word or form present in that log. This
  turns "is it producing filler?" from a judgement call into a boolean, and it is the cheapest guard
  protecting the project's one novel claim

### Layer 5 — End to end (Playwright, 4 specs)

| Spec | Flow |
|---|---|
| `e2e/drill.spec.ts` | Sign in → 5 cards → **assert zero network requests between cards** → streak increments |
| `e2e/assessment.spec.ts` | Full assessment → cards seeded sanely, estimated size shown |
| `e2e/done.spec.ts` | Nothing due → "done for today", no way to grind past it |
| `e2e/pwa.spec.ts` | Manifest served, service worker registers, install criteria met |

### Layer 6 — Privacy guard

`tests/privacy/no-leak.test.ts`, run in CI on every push. Scans for real first names, seed filenames,
third-party CDN hosts, API-key shapes, and any `.csv` outside `tests/fixtures/`. Fails the build on a
hit.

**Scope: everything git would publish — tracked files *and* untracked files no ignore rule covers.**
Tracked-only would leave a brand-new file exempt right up until someone stages it, which is exactly
the moment nobody reads the diff. `git ls-files --cached --others --exclude-standard`.

Three rules about how the guard is written, because a guard is only as good as its weakest habit:

1. **The name list is base64 in the tracked file.** Not security — anyone can decode it — but the
   plaintext is not sitting in a public repo to be indexed, *and the guard still runs in CI with no
   secrets*. A guard that needs a secret to work is a guard that quietly passes when the secret is
   missing. Working beats hidden.
2. **Zero path exemptions.** Every pattern is an escaped regex source, so the guard never matches
   itself and needs no self-exemption. An exemption is a hole in the one file most likely to contain
   an example of a forbidden thing.
3. **Every rule is tested against a canary** that must trip it. A typo that disables a rule fails
   the suite instead of passing forever.

The defence has to be structural. Anything depending on attention eventually fails.

### Discipline

1. **No `new Date()` outside `lib/time/clock.ts`.** Every pure function takes `now: Date`. Enforced
   by lint *and* a grep test — a lint rule can be silenced with an inline comment, a grep test
   cannot. Only the zero-argument forms are banned; `new Date(value)` parses and is fine anywhere.
   Fake timers are a workaround for a design smell
2. **`npm run test:tz`** runs the timezone-sensitive suites under `TZ=UTC`, `TZ=Europe/Berlin` and
   `TZ=Pacific/Auckland`. If a result changes, the bug is found before a learner loses a streak.

   **The suite is selected by filename — `*.tz.test.ts` — and the script has no
   `--passWithNoTests`, so an empty set fails.** Selecting by directory instead would print green
   while running nothing until the streak code lands, and would silently stop covering any file
   that got moved. **A check whose "pass" and whose "did nothing" look identical is not a check** —
   the rule applies to this suite as much as to the app
3. **Guards prove they are still alive.** Each privacy rule is tested against a canary that must
   trip it; the wall-clock grep tests its own patterns; both assert they found files to scan.
   Rule 2's shape, generalised
4. **Coverage thresholds only where meaningful:** 90% lines on `lib/fsrs`, `lib/study`,
   `lib/streak`, `lib/assessment`. No global target. They are added with the code they guard, not
   before it — a threshold over an empty directory is another vacuous pass
5. **Fixtures small and committed:** a 10-row corpus, a 500-row review log, 40 labelled answers

---

## 13. Configuration and deployment

### Scripts

```
dev          next dev
build        next build
start        next start
lint         eslint
typecheck    next typegen && tsc --noEmit
test         vitest run tests/unit tests/db tests/api
test:tz      the *.tz.test.ts suites under UTC, Europe/Berlin, Pacific/Auckland
test:e2e     playwright test
test:privacy vitest run tests/privacy
eval         opt-in AI evaluation suites (hits the real model)
db:generate  drizzle-kit generate
db:migrate   drizzle-kit migrate
invite       tsx scripts/create-invite.ts     issue an invite code
reset-password  tsx scripts/reset-password.ts reset a password locally
corpus:build pipeline stages 1–8           ← added at M2
corpus:load  scripts/load-corpus.ts        ← added at M2
```

**A script is added in the milestone that gives it something to point at**, never earlier. An
existing script that runs and does nothing gets trusted; a missing one gets written.

**`typecheck` generates route types first.** `LayoutProps`, `PageProps` and `RouteContext` are
global helpers Next writes into `.next/types` during `next dev`, `next build` or `next typegen`.
A bare `tsc --noEmit` passes on any machine that has run `next dev` recently and fails on a fresh
clone — so the script must not depend on a leftover build directory.

### Environment

```
DATABASE_URL                    Postgres (eu-central-1)
BETTER_AUTH_SECRET              openssl rand -hex 32
BETTER_AUTH_URL                 deployed origin
CRON_SECRET                     shared secret for /api/cron/*
OPENROUTER_API_KEY
OPENROUTER_MODEL_GRADING        tier 2
OPENROUTER_MODEL_NIGHTLY        tier 3
NEXT_PUBLIC_VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT                   mailto: address
BLOB_READ_WRITE_TOKEN           audio storage
```

No TTS credentials of any kind — the model runs locally at build time (§5).

`.env.example` carries empty values only. `.env*` is gitignored apart from the example.

### Runtime notes

- Functions on the Node runtime — the proxy convention does not support edge, and `web-push` needs
  Node
- Region `fra1`, database `aws-eu-central-1`
- Security headers per the PWA guidance; the service worker served `no-cache`
- Local PWA testing needs HTTPS: `next dev --experimental-https`

### Hosting: the default platform subdomain for now

Good enough for the first phase, including daily real use. A custom domain comes only if this becomes
a hosted product.

**Always use the stable production alias** (`<project>.vercel.app`), never a per-deployment URL. The
PWA install, the service worker scope, and every push subscription are bound to the origin they were
created on.

**One consequence to know before it happens, not during:** a PWA is tied to its origin. The day the
domain changes, everything origin-scoped resets —

| | |
|---|---|
| Installed home-screen app | must be re-installed on both phones |
| Push permission + subscriptions | re-granted; existing `push_subscriptions` rows become dead |
| Session cookies | everyone is logged out |
| `BETTER_AUTH_URL`, VAPID subject | need updating |

None of it is hard, and none of it is data loss — accounts, cards and review history all live in the
database and are untouched. But it is a deliberate **re-install day** with both learners present, not
something to discover from a silently broken nudge. The `cron_runs` staleness warning (§9.3) will
catch it if it is forgotten.

### Password reset: manual for now

No email provider in the first phase. "Manual" has to mean an actual mechanism, not editing rows by
hand, so M1 ships `scripts/reset-password.ts` — run locally against the database, sets a new password
for a given account. Admin-only by construction, since it never touches the deployed app.

A transactional email provider comes with hosted signup, together with verification and self-service
reset.

---

## 14. Verified constraints

Checked against primary sources rather than recalled. Re-check before relying on any of them.

| | |
|---|---|
| Free-tier cron (host) | 100 jobs/project, **minimum interval once per day**, precision **±59 min**, **UTC only** — unusable for a timed nudge |
| Paid tier | $20/month/developer — roughly twice the subscription this project replaces, so not the fix |
| Blob storage (free) | 1 GB storage, 10 GB transfer/month — ~150 MB needed |
| Database free tier | 0.5 GB storage, 100 compute-hours/month, **autosuspend after 5 min idle**, cold start 300–800 ms, time-to-first-query 0.5–1 s |
| Function region | Free tier **can** select one region; only enterprise gets multiple |
| iOS web push | Requires the site installed to the home screen; iOS 16.4+. Both target devices are well past this |
| GitHub Actions | Free on public repos; UTC only; scheduled runs delayed under load; **workflows disabled after 60 days of repo inactivity** |
| `ts-fsrs` | `Rating`: Manual 0, Again 1, Hard 2, Good 3, Easy 4. `State`: New 0, Learning 1, Review 2, Relearning 3. `Card`: due, stability, difficulty, elapsed_days *(deprecated in 6.0)*, scheduled_days, learning_steps, reps, lapses, state, last_review |
| Framework (v16) | `middleware` → `proxy`, no edge runtime; `cookies`/`headers`/`params`/`searchParams` async-only; `next lint` removed; `revalidateTag` needs a second argument; Turbopack default for dev and build |
| Dependencies | i18n and auth libraries both peer-support the installed framework major |
| CEFR-J Vocabulary Profile v1.5 | ~7,000 English entries, A1–B2, + Octanove C1/C2. CC BY-SA 4.0, **explicitly commercial-OK with citation**. Tono Laboratory, Tokyo University of Foreign Studies |
| Nuovo vocabolario di base (Italian) | ~7,000 entries in three usage bands (FO ≈2,000 / AU ≈3,000 / AD ≈2,000), De Mauro & Chiari, 2016. Machine-readable extraction released **public domain**; underlying selection is editorial — caution before commercial use |
| Kelly (IT, EN + 7) | CEFR + frequency, **CC BY-NC-SA 2.0 — non-commercial only** |
| FSI language courses | US government, **public domain**, but 1960s material in PDF form — dated vocabulary, extraction required. Not used |
| UniversalCEFR | 505,807 CEFR-labelled *texts* in 13 languages incl. Italian. Useful for grading reading material later; not a word list |
| Kokoro-82M TTS | **Apache 2.0**, 54 voices across 8–9 languages incl. Italian (2) and English (28), 82M params, runs on laptop CPU ⇒ **€0** |
| Cloud TTS APIs | ~$4/M characters would be under €2 for the whole library — **but** their terms cover synthesis per request, and building a permanent stored audio library is not automatically included. Avoided for that reason, not for cost |
| LexTALE | 60 items (40 words + 20 pseudowords), ~5 min, validated against a commercial placement test |
| LexITA | Italian adaptation: 60 words + 30 pseudowords, validated across L2 proficiency levels |

---

## 15. Non-goals

| | Why |
|---|---|
| Illustrations, mascots, characters | Expensive, teach nothing |
| Leagues against strangers | Pointless at this scale |
| Hearts / lives | That *is* the paywall being escaped |
| A locked unit path | An engagement machine. FSRS orders material better |
| Bring-your-own word lists | Keeps content global and the schema simple. The assessment proposes a level instead |
| Matching commercial polish | A decade of animation and UX tuning is not reproducible here. That is the honest trade |

**Design rule:** the first phase must be enjoyable on its own, not a skeleton waiting for the second.

---

## 16. Open questions

**All five previously open items are now closed:**

| | | |
|---|---|---|
| Hosting | Default platform subdomain for the first phase; custom domain only if this becomes hosted | §13 |
| Courses | `it-from-en` and `en-from-de` — both confirmed | below |
| Password reset | Manual via a local script; email provider deferred to hosted signup | §13 |
| Model prices | Not a decision, a 5-minute check at M6 | below |
| TTS terms | Resolved by removing the dependency — local Apache-2.0 model, no provider | §5 |

### The two courses

- **`it-from-en`** — Italian lemmas, English translations. Italian frequency list, Tatoeba it↔en.
- **`en-from-de`** — English lemmas, German translations. English frequency list, Tatoeba en↔de
  (one of the largest pairs in the corpus). Learner profile: UI locale `de`, base language `de`,
  target `en`. All AI prose for this learner is written in German (§8).

Both language pairs are well covered by every source in §5.

### Model selection at M6 (not a blocker, not a task with a deliverable)

The cost figures in §14 come from a price snapshot. Model prices fall and new models appear
constantly, so **the choice of model should be made when the code is written, not inherited from a
month-old table.** Two models get picked:

- one for **tier 2** — grading typed answers, needs low latency and reliable structured output
- one for **tier 3** — the nightly job, where latency is irrelevant so it can be a stronger model

Five minutes reading the current provider model list at M6. **Cost is not the constraint** — the
whole AI budget is single-digit euros per month — so this is about picking the best model for the
money at the time, not about affordability. The `ai_calls` table (§4) then shows what it actually
costs rather than what was estimated.

### Genuinely still open

Nothing blocking. Three things to watch rather than decide now:

1. **Italian TTS quality** from a 2-voice model. Decided by ear at M2, before generating at scale.
2. **Whether the deck is pleasant to study.** Much less of a risk now that the order is pedagogical
   rather than corpus-derived, but still judged by using it in week one, not by inspection.

The Italian word list's commercial status (§5, rule 2) is **accepted and closed** — it is a question
for the day someone is charged, not a question for the build.

---

## Licence and attribution

Application code: MIT.

Derived content is published under CC BY-SA with attribution to its sources, per §5. The attribution
file is generated by the pipeline. The non-commercial CEFR data is optional and nothing depends on
it.
