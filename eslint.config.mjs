import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * The wall clock is read in exactly one file. Everything else takes `now: Date`.
 * See lib/time/clock.ts and PLAN.md §3.
 *
 * Only the zero-argument forms are banned — `new Date(someTimestamp)` parses a
 * value and is fine anywhere.
 */
const noWallClock = [
  "error",
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      "No new Date() outside lib/time/clock.ts. Take `now: Date` as a parameter, or use a Clock.",
  },
  {
    selector:
      "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message:
      "No Date.now() outside lib/time/clock.ts. Take `now: Date` as a parameter, or use a Clock.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-syntax": noWallClock,
    },
  },
  {
    files: ["lib/time/clock.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Ours:
    "coverage/**",
    "pipeline/out/**",
  ]),
]);

export default eslintConfig;
