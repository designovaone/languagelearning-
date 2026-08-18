import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // `@/*` path aliases come from tsconfig.json. Vite resolves these natively
  // now, so the vite-tsconfig-paths plugin named in PLAN.md §12 is not needed.
  resolve: { tsconfigPaths: true },
  test: {
    // Node is the default. Component tests opt in per file with the
    // `@vitest-environment jsdom` docblock, so the common case stays fast.
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.{ts,tsx}"],
    // Playwright owns tests/e2e/*.spec.ts; the include above already excludes it.
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts"],
      reporter: ["text", "html"],
      // PLAN.md §12: 90% lines on the modules where a silent wrong answer is
      // expensive. No global target — a repo-wide number rewards testing the
      // easy files and says nothing about the hard ones.
      //
      // `lib/streak` is named in the plan and lands at M7 with the streak
      // itself. A threshold pointing at a directory that does not exist is the
      // vacuous-pass problem in another costume — and this was checked rather
      // than assumed: a glob matching no files reports nothing at all, not a
      // failure. So a threshold is added only once there is code under it.
      thresholds: {
        "lib/fsrs/**": { lines: 90 },
        "lib/study/**": { lines: 90 },
        "lib/assessment/**": { lines: 90 },
      },
    },
  },
});
