import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PLAN.md §12, Discipline rule 1: the wall clock is read in exactly one file.
 *
 * ESLint enforces this too. The grep exists because a lint rule can be disabled
 * inline with a comment and nobody would notice; this one cannot.
 *
 * Patterns are built from escaped sources on purpose, so this file does not
 * match itself and needs no exemption. Zero exemptions means no hole to widen.
 */
const WALL_CLOCK_PATTERNS = [
  { name: "zero-argument Date constructor", source: "new\\s+Date\\s*\\(\\s*\\)" },
  { name: "Date dot now", source: "\\bDate\\.now\\s*\\(\\s*\\)" },
] as const;

const ALLOWED = new Set(["lib/time/clock.ts"]);

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * Tracked files *plus* untracked files git would happily publish. Scanning only
 * tracked files means a brand-new file is exempt until someone stages it, which
 * is exactly when nobody is looking.
 */
function publishableSourceFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return out.split("\0").filter((p) => p.length > 0);
}

describe("no wall clock outside lib/time/clock.ts", () => {
  const files = publishableSourceFiles();

  it("finds TypeScript to scan", () => {
    // Guards against the scan passing because it looked at nothing.
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("lib/time/clock.ts");
  });

  it("has no zero-argument Date reads outside the one allowed file", () => {
    const offences: string[] = [];

    for (const file of files) {
      if (ALLOWED.has(file)) continue;
      const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
      for (const { name, source } of WALL_CLOCK_PATTERNS) {
        const re = new RegExp(source);
        lines.forEach((line, i) => {
          if (re.test(line)) offences.push(`${file}:${i + 1} uses ${name}`);
        });
      }
    }

    expect(offences).toEqual([]);
  });

  it("actually detects the thing it is looking for", () => {
    // Non-vacuity: build the banned forms without writing them literally.
    const planted = ["new", " ", "Date", "()"].join("");
    const plantedNow = ["Date", ".", "now", "()"].join("");
    const hits = WALL_CLOCK_PATTERNS.filter(({ source }) =>
      new RegExp(source).test(`${planted}\n${plantedNow}`),
    );
    expect(hits).toHaveLength(WALL_CLOCK_PATTERNS.length);
  });
});
