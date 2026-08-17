@AGENTS.md

# Start here: PLAN.md

`/PLAN.md` is the build document and the single source of truth — what gets built, in what
order, and why. Read it before writing code. Milestone status lives in §11.

If the build departs from it, **amend PLAN.md in the same session**. It is the only project
record that survives a fresh clone, so an un-amended plan gets faithfully re-implemented and
the fix gets undone.

Two conventions the test suite depends on, easy to break by accident:

- **`lib/time/clock.ts` is the only file allowed a zero-argument `new Date()` or `Date.now()`.**
  Everything else takes `now: Date`. Enforced by ESLint *and* by a grep test.
- **Timezone-sensitive tests are named `*.tz.test.ts`.** `npm run test:tz` selects them by that
  name and fails on an empty set. Renaming a file drops it from the sweep.
