# Known gaps

Things that are missing, deferred, or would surprise someone using this. Kept here rather than in
`PLAN.md`, which describes what gets built; this describes what is not yet true.

**Rule:** an entry leaves this file when it is fixed *or* when it is consciously accepted and moved
into `PLAN.md`. Nothing gets deleted just because it stopped being annoying.

---

## Blocking a real test drive

| | | Lands |
|---|---|---|
| ~~No content~~ | **Fixed.** 14,904 words across two courses are live: `it-from-en` 7,083 (FO/AU/AD), `en-from-de` 7,821 (A1–C2). No sentences yet | stage 7 |
| ~~No enrollment on signup~~ | **Fixed.** The signup form asks which course, and the learner is enrolled. An unknown slug falls back to the locale default rather than being trusted | — |
| ~~Words are ordered alphabetically within a band~~ | **Fixed.** Stage 1b blends OpenSubtitles and Wikipedia frequency by the geometric mean of the ranks. 100.0% of Italian and 99.8% of English lemmas carry a `freq_rank`; the deck now opens on common words | — |
| **Band 1 now opens on function words, and their cards are the worst ones** | Italian starts `e, di, il, la, che`, English `the, to, a, of`. Two problems at once: as word cards these teach little (`il / la / lo / le / gli` are five cards all meaning "the"), *and* they attract the worst translations, because a function word has no single equivalent — the live deck currently shows `is` → "IS", `a` → "A", and Italian `di` → "used to indicate possession". Not fixed, because the assessment seeds them as known before the drill runs (M3 precedes M4). **Verify that on the first real session rather than assuming it** | M3, then judge |
| **Verbs skew late within a band** | The corpora count surface forms, so `dovere` and `volere` rank on their infinitives alone and land at 1,388 and 1,284 of the 2,019-word FO band. 63% of FO verbs fall in the back half against a 50% baseline. Lemmatising the corpus (stage 2) is the real fix | stage 2 |
| ~~Translations are a ranked shortlist, not a chosen sense~~ | **Fixed.** Stage 5 ran for $0.07. All 14,904 cards carry a chosen primary sense; 4 rows fell back out of 12,346 decisions (0.03%). 100 hand-checked words came back ~95% good | — |
| **A handful of cards are still weak** | From the 100-word hand-check: `succo` → "juice except tomato juice" and `svolazzare` → "to fly here and there without precise di…" keep Wiktionary phrasing; `aziendale` (adj.) → "firm" (a noun); `paramount` → "hervorragend" rather than "vorrangig". Roughly 5%. Not worth another pass on its own — fold into a review queue if one is built | admin review queue |
| **Two rows are stage 4 residue** | `would` → "We sat on the bench" (English usage examples leaked into the German translation field — the only such row in 7,821), and Italian `pinna` carries the *English* noun's definitions (ear/auricle) rather than "fin". Fixing either means re-running the 3.2 GB stage 4 extraction | stage 4, if ever re-run |
| **No audio** | `listening` cards cannot render | stage 8 |
| **No drill** | `/study` renders the "done for today" copy unconditionally. It is a session-gate placeholder, not the loop | M4 |
| **No assessment** | Nothing seeds FSRS state, so even with content every card would start `New` | M3 |

## Working, but thinner than it looks

| | |
|---|---|
| **Settings is read-only** | Shows the email and an export link. No locale switcher, no timezone edit, no daily-limit controls. The columns exist and are populated at signup; nothing edits them afterwards |
| **Account deletion has no UI** | `DELETE /api/me` works and is tested, but nothing in the app calls it. The settings page links only to export |
| **Timezone is captured once** | Taken from the browser at signup (`Intl.DateTimeFormat().resolvedOptions().timeZone`). A learner who moves has no way to change it |
| **UI locale is chosen once** | Picked on the signup form. Changing it means a database edit |
| **Email verification is off** | Deliberate — there is no email provider in the first phase (PLAN §13). It means an address is never proven to belong to the person |
| **Password reset is local-only** | `npm run reset-password` runs against the database from this machine. A locked-out learner has to ask an admin |
| **No invite admin surface** | Codes are issued with `npm run invite`. `profiles.role` exists but nothing reads it |

## Operational

| | |
|---|---|
| **`BETTER_AUTH_URL` is `http://localhost:3000`** | Correct locally, wrong the moment this deploys. **The PWA install, the service worker scope and every push subscription bind permanently to the origin they were created on** (PLAN §13). Change it as part of the first deploy, not after |
| **`drizzle-kit` does not read `.env.local`** | Run migrations as `node --env-file=.env.local node_modules/drizzle-kit/bin.cjs migrate`. A bare `npm run db:migrate` finds no URL and stops |
| **`.env.local` values need quoting** | The Neon URL contains `&`, which breaks `set -a; . ./.env.local`. `DATABASE_URL` is quoted for that reason |
| **Migrations run against the pooled endpoint** | It works today. If a future migration needs a session-level lock, the direct (non-pooler) endpoint may be required |
| **No rate limiting configured on sign-in** | Better Auth ships defaults; nothing here has been tuned or tested. Worth a look before the URL is public |

## Test-suite debt

| | |
|---|---|
| **Coverage thresholds not wired** | PLAN §12 wants 90% lines on `lib/fsrs`, `lib/study`, `lib/streak`, `lib/assessment`. None of those directories exist yet; the thresholds land with the code they guard |
| **No Playwright specs** | `npm run test:e2e` runs an empty suite. The four specs in PLAN §12 Layer 5 depend on the drill existing |
| **`npm run eval` is empty** | Opt-in AI evaluation arrives at M6 |
| **The API auth-gate sweep covers three routes** | It asserts that *every* API route checks a session or a cron secret, so it grows automatically — but today that is a small set |
| **The privacy guard is not enforced before a push** | It runs as `npm run test:privacy` and in CI, but nothing stops a local commit. A tracked file was once committed and pushed carrying two real first names and a home-directory path; the guard had last been run before that file existed. History was rewritten and force-pushed to fix it. A pre-commit hook would have caught it at the source |
| **No test hits the real database** | Everything runs on PGlite. PGlite is real Postgres 18 but not the serverless driver, connection limits or cold starts. PLAN §12 calls for one manual smoke test against a dev branch; it has not been done |

## Accepted, not problems

Listed so they are not rediscovered as bugs.

- **`elapsed_days` is written and never read.** Deprecated in ts-fsrs 6.0; the column stays because 5.x still writes it (PLAN §4).
- **`grammar_items.created_by` holds `'nightly'` / `'manual'`, not a user id.** The GDPR sweep excludes it explicitly for that reason.
- **`audio_assets` carries `source` but no `license`.** The licence is the model's, recorded once in the generated attribution file rather than on every row.
- **The invite code alphabet omits `O`, `0`, `I`, `1` and `L`.** These get read aloud.
