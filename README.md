# Language learning app

> A self-hosted spaced-repetition language trainer for a household of two learners.
> Built to fix one specific complaint about Duolingo: **words you already know come
> back far too often.**

**Status: early. Nothing to run yet.** This repo is being built in the open, and this
README describes the plan before the code exists. That is deliberate — see
[Why this is public](#why-this-is-public).

---

## The problem

Two people study a language daily on a big commercial app. Two complaints:

1. The free tier is crippled — ads, hearts, locked features.
2. The repetition is poor. Easy words reappear constantly while study time is wasted.

Complaint 1 can be solved with money. **Complaint 2 cannot** — paying for the premium
tier removes the paywall but does not change the scheduling algorithm. That gap is the
entire reason this project exists.

## The fix

**FSRS** — the Free Spaced Repetition Scheduler — is an open algorithm that decides when
a card should come back. It measurably outperforms older SM-2 style schedulers, and it
ships as a maintained npm package ([`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs)).

So the hard part is not invented here. It is wired in.

## The idea worth stealing

**FSRS can schedule more than words.** A grammar rule is a card. A verb conjugation is
a card. Anything you can get right or wrong goes into the same scheduler.

Commercial language apps generally leave grammar *implicit* — you are meant to absorb it
from examples, and nothing tracks whether you actually did. Here, when the nightly pass
notices a recurring mistake, it turns that mistake into a card and schedules it like any
other: back in 3 days, then 9, then 25.

That is the one structural advantage this project has, and it is cheap to get.

## How AI is used (and where it isn't)

Three tiers, sorted by how long a human will tolerate waiting:

| Tier | Latency budget | What runs there |
|---|---|---|
| **1 — no AI** | instant | FSRS picks the next card (sub-millisecond). Card content is pre-generated in the database. Multiple choice grades by exact match. |
| **2 — live AI** | 1–2 s | Grading typed answers. "Why was I wrong?" Conversation practice. |
| **3 — nightly AI** | irrelevant | A scheduled job reads yesterday's mistakes, finds the pattern, and generates tomorrow's material aimed at the weak spots. |

**There is deliberately no AI call in the path of a normal card.** Not because of cost —
cost is minor — but because of waiting. At 1.5 s per call and 150 cards in a session,
that is roughly four minutes of spinner, plus 150 chances for a timeout to break the
drill.

The nightly approach is also simply better: the model sees a whole week of errors at
once instead of one word in isolation.

## Scope

**Phase 1 — the minimum that replaces the commercial app**

1. Vocabulary drills on FSRS, both directions
2. Grammar rules as FSRS cards
3. Listening — hear the word, pick or type the meaning
4. Typed recall with live AI grading
5. **A shared streak between the two learners**
6. The nightly coach

Item 5 is not decoration. These apps work because of the streak and the nudge, not
because the exercises are clever. Two people who see each other every day is a stronger
mechanic than a league of strangers.

**Phase 2 — decided after actually using Phase 1**

- Personalised stories, generated nightly from words the learner already knows
- Speaking, via the browser's built-in speech recognition
- Paste real text (an article, song lyrics) and mine the unknown words

**Deliberately not built**

| | Why |
|---|---|
| Illustrations, mascots, characters | Expensive, teach nothing |
| Leagues against strangers | Pointless at this scale |
| Hearts / lives | That *is* the paywall being escaped |
| A locked unit path | An engagement machine. FSRS orders material better |

**What this will never match:** polish. A decade of animation, sound design and UX
tuning is not reproducible here. That is the honest trade.

**The real risk is habit, not features.** If it doesn't feel like five easy minutes, the
better algorithm is worthless, because nobody opens it. Design rule: Phase 1 has to be
enjoyable on its own, not a skeleton waiting for Phase 2.

## Intended stack

Next.js · Drizzle ORM · Postgres (Neon) · Vercel · `ts-fsrs` · an LLM via OpenRouter.

Expected running cost: single-digit euros per month. Free tiers cover everything except
the model calls.

## Prior art

The landscape was surveyed before starting, and nothing off the shelf fit — the good
AI-powered apps are Docker/VPS-only and mostly lack spaced repetition entirely, while the
apps on the right stack are scaffolds with no scheduling logic. Projects worth knowing
about, all of them more mature than this one:

- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) — the scheduler this depends on
- [Anki](https://github.com/ankitects/anki) — the gold standard for repetition
- [LinguaCafe](https://github.com/simjanos-dev/LinguaCafe) and [Lute](https://github.com/LuteOrg/lute-v3) — learn-by-reading, mature and active
- [wordpecker-app](https://github.com/baturyilmaz/wordpecker-app) — AI exercises over your own word lists
- [duolingo-clone](https://github.com/sanidhyy/duolingo-clone) — a clean Next.js + Drizzle + Neon reference

**If you just want better repetition today, use Anki.** It is free, mature, has FSRS
built in, and there are ready-made decks for most languages. This project exists because
Anki has no streak, no nudge, and no shared progress — not because Anki repeats badly.

## Data

Seed vocabulary is **not** included in this repository. The lists used privately are
scraped third-party course content, so only the loading script is published, not the
data. Any CSV with columns `order,unit,unit_name,unit_topic,word,translations,audio_url`
will load.

## Why this is public

The build is being written up as it happens — what worked, what was over-engineered,
what got thrown away. Open-sourcing it keeps that account honest and makes the code
citable when it is discussed.

It is **not** a product. There is no hosted version, no support, and no roadmap
commitment. Fork it if it is useful.

## Licence

MIT — see [LICENSE](LICENSE).
