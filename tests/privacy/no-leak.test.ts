import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PLAN.md §12, Layer 6 — the privacy guard.
 *
 * This repo is public and the personal material sits one directory away from
 * the working material. The defence therefore has to be structural: a check
 * that runs on every push and fails the build. Anything that depends on someone
 * remembering will eventually fail.
 *
 * Scope: everything git would publish — tracked files *and* untracked files
 * that no ignore rule covers. Anything gitignored is by definition not
 * published, and scanning it would just make the guard slow and noisy.
 * Tracked-only would be worse: a new file would be exempt right up until
 * someone stages it, which is the moment nobody is looking.
 *
 * Two things about how this file is written:
 *
 * 1. Personal tokens are base64. Not as security — anyone can decode it — but
 *    so the plaintext is not sitting in a public repo for a search engine to
 *    index. The guard still runs in CI with no secrets, which is the property
 *    that matters: a guard that needs a secret to work is a guard that quietly
 *    passes when the secret is missing.
 * 2. Every regex is written with escapes so this file does not match itself.
 *    There are no path exemptions. An exemption is a hole, and the one file
 *    most likely to end up holding an example of a forbidden pattern is the
 *    file that lists them.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const MAX_BYTES = 2_000_000;

const BINARY_EXTENSIONS = new Set([
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".wav",
  ".ogg",
  ".pdf",
  ".zip",
  ".gz",
]);

function decode(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Rule = {
  readonly name: string;
  readonly re: RegExp;
  /** A string that must trip this rule, for the non-vacuity test. */
  readonly canary: string;
};

/** Real first names and the personal address, never in tracked files. */
const PERSONAL_TOKENS_B64 = [
  "UmljaGFyZA==",
  "QW5kcmVh",
  "ZGVzaWdub3Zhb25lQGdtYWlsLmNvbQ==",
];

const personalRules: Rule[] = PERSONAL_TOKENS_B64.map((b64) => {
  const token = decode(b64);
  return {
    name: "personal identifier",
    re: new RegExp(`\\b${escapeRegex(token)}\\b`, "i"),
    canary: `hello ${token} there`,
  };
});

/**
 * Third-party hosts the app must never reach out to. A CDN in a PWA is a
 * request the learner did not agree to; the borrowed-content hosts are also the
 * shape of the dependency this project spent a pivot removing.
 */
const HOST_SOURCES = [
  "tts-static\\.duolingo\\.cn",
  "d35aaqx5ub95lt\\.cloudfront\\.net",
  "cdn\\.jsdelivr\\.net",
  "unpkg\\.com",
  "cdnjs\\.cloudflare\\.com",
  "fonts\\.googleapis\\.com",
  "fonts\\.gstatic\\.com",
  "ajax\\.googleapis\\.com",
];

const hostRules: Rule[] = HOST_SOURCES.map((source) => ({
  name: "third-party host",
  re: new RegExp(source, "i"),
  canary: `https://${source.replace(/\\/g, "")}/thing.js`,
}));

/** Credential shapes. Catches the paste that was meant for .env. */
const secretRules: Rule[] = [
  {
    name: "OpenAI/OpenRouter-style key",
    re: /\bsk-[A-Za-z0-9_-]{24,}/,
    canary: ["sk", "-", "a".repeat(30)].join(""),
  },
  {
    name: "GitHub token",
    re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
    canary: ["ghp", "_", "A".repeat(36)].join(""),
  },
  {
    name: "GitHub fine-grained token",
    re: /\bgithub_pat_[A-Za-z0-9_]{30,}/,
    canary: ["github", "_pat_", "B".repeat(40)].join(""),
  },
  {
    name: "AWS access key id",
    re: /\bAKIA[0-9A-Z]{16}\b/,
    canary: ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
  },
  {
    name: "Vercel blob token",
    re: /\bvercel_blob_rw_[A-Za-z0-9_]{20,}/,
    canary: ["vercel", "_blob_rw_", "C".repeat(30)].join(""),
  },
  {
    name: "npm token",
    re: /\bnpm_[A-Za-z0-9]{30,}/,
    canary: ["npm", "_", "D".repeat(36)].join(""),
  },
  {
    name: "Postgres URL with an inline password",
    re: /\bpostgres(?:ql)?:\/\/[^\s:/@]+:[^\s/@]+@/,
    canary: ["postgres", "://user:", "hunter2", "@host/db"].join(""),
  },
  {
    name: "PEM private key",
    re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/,
    canary: ["-----BEGIN", " RSA PRIVATE KEY", "-----"].join(""),
  },
];

const ALL_RULES: Rule[] = [...personalRules, ...hostRules, ...secretRules];

function publishableFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return out.split("\0").filter((p) => p.length > 0);
}

/** True when git would refuse to publish this path. Exit 0 = ignored, 1 = not. */
function isIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--no-index", "-q", "--", path], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function isScannable(path: string): boolean {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return false;
  try {
    return statSync(join(REPO_ROOT, path)).size <= MAX_BYTES;
  } catch {
    return false;
  }
}

function scan(text: string, rules: readonly Rule[]): string[] {
  const hits: string[] = [];
  const lines = text.split("\n");
  for (const rule of rules) {
    lines.forEach((line, i) => {
      if (rule.re.test(line)) hits.push(`line ${i + 1}: ${rule.name}`);
    });
  }
  return hits;
}

describe("privacy guard", () => {
  const files = publishableFiles();
  const scannable = files.filter(isScannable);

  it("has files to scan", () => {
    // A guard that passes because it looked at nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(0);
    expect(scannable.length).toBeGreaterThan(0);
    expect(scannable).toContain("PLAN.md");
  });

  it("detects every pattern it claims to detect", () => {
    // Non-vacuity: each rule is proven live against its own canary. A typo that
    // silently disables a rule fails here instead of passing forever.
    const dead = ALL_RULES.filter((rule) => !rule.re.test(rule.canary));
    expect(dead.map((r) => `${r.name} :: ${r.re}`)).toEqual([]);
  });

  it("finds no personal identifiers, third-party hosts or credentials", () => {
    const offences: string[] = [];
    for (const file of scannable) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const hit of scan(text, ALL_RULES)) offences.push(`${file} ${hit}`);
    }
    expect(offences).toEqual([]);
  });

  it("tracks no .csv outside tests/fixtures/", () => {
    const stray = files.filter(
      (p) => p.toLowerCase().endsWith(".csv") && !p.startsWith("tests/fixtures/"),
    );
    expect(stray).toEqual([]);
  });

  it("tracks nothing under seed/ or backups/", () => {
    const stray = files.filter(
      (p) => p.startsWith("seed/") || p.startsWith("backups/"),
    );
    expect(stray).toEqual([]);
  });

  it("tracks no local-only memory or session files", () => {
    const stray = files.filter(
      (p) => p === "MEMORY.md" || p.startsWith("CLAUDESESSIONS/"),
    );
    expect(stray).toEqual([]);
  });

  it("tracks no real env file", () => {
    const stray = files.filter(
      (p) => p.split("/").pop()!.startsWith(".env") && !p.endsWith(".env.example"),
    );
    expect(stray).toEqual([]);
  });

  it("keeps the local-only files actually ignored", () => {
    // The .gitignore rules are the other half of the defence. If someone
    // rewrites that file, this fails before the next `git add .` publishes.
    const mustBeIgnored = [
      "MEMORY.md",
      "CLAUDESESSIONS/notes.md",
      ".env.local",
      ".env.production",
      "seed/anything.csv",
      "backups/dump.sql",
    ];
    const notIgnored = mustBeIgnored.filter((p) => !isIgnored(p));
    expect(notIgnored).toEqual([]);
  });

  it("keeps test fixtures publishable despite the blanket *.csv rule", () => {
    // The bare *.csv rule protects bulk content but would silently swallow the
    // committed fixtures the test suite is built on. The negation must win.
    expect(isIgnored("tests/fixtures/corpus.csv")).toBe(false);
    expect(isIgnored(".env.example")).toBe(false);
  });
});
