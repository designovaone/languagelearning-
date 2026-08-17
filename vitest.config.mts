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
      // Thresholds land with the code they guard (PLAN.md §12): 90% lines on
      // lib/fsrs, lib/study, lib/streak, lib/assessment. No global target.
    },
  },
});
