# How to test it

What works today, how to run it, and what you should expect to be missing. Written after M2
stage 9 — there is real content in the database, but no drill yet.

---

## 1. Start it

```bash
cd path/to/languagelearning
npm install          # only needed after a fresh clone
npm run dev
```

Open **http://localhost:3000**.

You need `.env.local` with `DATABASE_URL` filled in. It already is.

## 2. Get yourself an invite code

Signup is invite-only, and there is no admin screen yet — codes come from the command line.

```bash
node --env-file=.env.local node_modules/.bin/tsx scripts/create-invite.ts --days 60
```

It prints one code, like `8CVW-52PU-K8MM`. The alphabet has no `O`, `0`, `I`, `1` or `L`, so it
survives being read aloud.

## 3. Sign up

Go to **/sign-up**. Five fields:

| | |
|---|---|
| Name, Email | anything; the email is never verified because there is no mail provider yet |
| Password | **at least 12 characters** |
| Invite code | from step 2 |
| Language | `English` or `Deutsch` — sets the whole interface |
| Course | `Italian, explained in English` or `Englisch, auf Deutsch erklärt` |

Pick **Deutsch + Englisch auf Deutsch erklärt** at least once. That is the German-speaking
learner's path, and it is the half most likely to be quietly wrong.

## 4. What you should see

The dashboard shows the **real deck**, read from the database:

```
Italian from English
7,083
words in the deck

Fondamentale          1,962
Alto uso              2,944
Alta disponibilità    2,177
```

For the German course you should get 7,821 words across A1–C2.

If you see `0`, the enrollment did not happen — that is a bug, tell me.

---

## What to actually poke at

### The invite gate

This is the security-critical piece, so it is worth trying to break by hand.

- Sign up **without** a code → refused
- Sign up with a **made-up** code → refused
- Use the **same code twice** → the second is refused
- Compare the two error messages → **they should be identical**. If unknown and already-used gave
  different messages, anyone could probe which codes exist.

### German really is German

Sign up with Language = Deutsch and check the interface is German throughout — buttons, errors,
the lot. A half-translated UI is the most likely quiet failure in this project, and it is the
German-speaking learner's whole experience.

### Your data

`/settings` → **Download my data** gives you every row the app holds about you as JSON. Check that
the password hash is **not** in it.

### Log out and back in

Visit `/study` while logged out — it should send you to sign-in, not show you a shell.

---

## What is deliberately missing

Not bugs. Each has a stage or milestone that closes it, and each is listed in `ISSUES.md`.

| | |
|---|---|
| **No drill** | `/study` shows the "done for today" text no matter what. The real loop is M4 |
| **Words run alphabetically inside a band** | A first session would be all `a…` words. Frequency ordering needs pipeline stage 1b |
| **Second and third translations are noisy** | `house` → Haus, Kammer, Kind. The first one is right; picking the single best sense is stage 5's AI pass |
| **No example sentences** | Stage 7 |
| **No audio** | Stage 8, so no listening exercises |
| **No assessment** | M3, so nothing seeds your starting level |
| **Settings is read-only** | You can see your email and export your data; you cannot change your language, timezone or limits yet |
| **No streak, no notifications** | M7 |

## If you get locked out

```bash
node --env-file=.env.local node_modules/.bin/tsx scripts/reset-password.ts you@example.com
```

It asks for the new password twice, on the terminal. There is no email-based reset — deliberately,
because there is no mail provider in this phase.

---

## Running the checks yourself

```bash
npm test              # 102 tests: unit, database, API
npm run test:tz       # timezone-sensitive suites under UTC, Berlin, Auckland
npm run test:privacy  # scans everything git would publish for names, keys, CDNs
npm run typecheck
npm run lint
```

All of these run on every push, and they need no secrets.

## Reloading the content

Safe to run any time — it updates in place rather than duplicating.

```bash
node --env-file=.env.local node_modules/.bin/tsx scripts/load-corpus.ts
```

Rebuilding the artifacts from scratch is only needed if a source changes:

```bash
pip3 install -r pipeline/requirements.txt
pipeline/stages/00_fetch_sources.sh
cd pipeline/stages
python3 01_italian_nvdb.py && python3 01_english_cefrj.py
python3 04_translations_italian.py && python3 04_translations_english.py
```

The stage-4 scripts stream several hundred megabytes each on their first run and cache what they
matched, so a second run is fast.

---

## The one thing to decide before deploying

`BETTER_AUTH_URL` in `.env.local` still says `http://localhost:3000`.

A PWA belongs to its origin permanently. The day this gets a real URL, both phones re-install, push
permission is re-granted, every stored subscription dies, and everyone is logged out. No data loss —
accounts, cards and history are all in the database — but it is a deliberate **re-install evening
with both learners present**, not something to discover from a silently broken reminder.
