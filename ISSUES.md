# Known gaps

Things that are missing, deferred, or would surprise someone using this. Kept here rather than in
`PLAN.md`, which describes what gets built; this describes what is not yet true.

**Rule:** an entry leaves this file when it is fixed *or* when it is consciously accepted and moved
into `PLAN.md`. Nothing gets deleted just because it stopped being annoying.

---

## Blocking a real test drive

| | | Lands |
|---|---|---|
| **No content at all** | `courses`, `bands`, `words` and `sentences` are empty. Signing in works; there is nothing to study. The dashboard shows `—` because there is nothing to count | M2 |
| **No enrollment on signup** | Signup creates `user` + `profiles` but no `enrollments` row, because there is no course to enrol in yet. A learner is therefore not attached to a course | M2 |
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
| **No test hits the real database** | Everything runs on PGlite. PGlite is real Postgres 18 but not the serverless driver, connection limits or cold starts. PLAN §12 calls for one manual smoke test against a dev branch; it has not been done |

## Accepted, not problems

Listed so they are not rediscovered as bugs.

- **`elapsed_days` is written and never read.** Deprecated in ts-fsrs 6.0; the column stays because 5.x still writes it (PLAN §4).
- **`grammar_items.created_by` holds `'nightly'` / `'manual'`, not a user id.** The GDPR sweep excludes it explicitly for that reason.
- **`audio_assets` carries `source` but no `license`.** The licence is the model's, recorded once in the generated attribution file rather than on every row.
- **The invite code alphabet omits `O`, `0`, `I`, `1` and `L`.** These get read aloud.
