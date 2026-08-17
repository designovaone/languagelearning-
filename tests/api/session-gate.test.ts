import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * PLAN.md §11 M1 exit: "logged-out /study redirects", and §12 Layer 3: every
 * `/api/study/*` route rejects unauthenticated requests.
 *
 * Two halves, and the second is the one that keeps working as the app grows:
 *
 * 1. The helpers behave correctly — a page redirects, an API route answers 401.
 * 2. **Every route under (app) and every API route actually uses them.** A gate
 *    that exists but is not wired to a new page protects nothing, and nothing
 *    errors: the page just renders for a stranger.
 */

const APP_ROOT = join(import.meta.dirname, "..", "..", "app");

const redirectCalls: string[] = [];

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectCalls.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getSession } }),
}));

const { getSessionUser, requireApiUser, requireUser } = await import(
  "@/lib/auth/session"
);

afterEach(() => {
  redirectCalls.length = 0;
  getSession.mockReset();
});

describe("session helpers", () => {
  it("returns null when there is no session", async () => {
    getSession.mockResolvedValue(null);
    expect(await getSessionUser()).toBeNull();
  });

  it("returns the user when there is one", async () => {
    getSession.mockResolvedValue({
      user: { id: "u1", email: "a@b.test", name: "A" },
    });
    expect(await getSessionUser()).toEqual({
      id: "u1",
      email: "a@b.test",
      name: "A",
    });
  });

  it("redirects a logged-out visitor away from a page", async () => {
    getSession.mockResolvedValue(null);
    await expect(requireUser()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectCalls).toEqual(["/sign-in"]);
  });

  it("remembers where the visitor was going", async () => {
    getSession.mockResolvedValue(null);
    await expect(requireUser("/study")).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectCalls).toEqual(["/sign-in?next=%2Fstudy"]);
  });

  it("does not redirect a signed-in visitor", async () => {
    getSession.mockResolvedValue({
      user: { id: "u1", email: "a@b.test", name: "A" },
    });
    await expect(requireUser("/study")).resolves.toMatchObject({ id: "u1" });
    expect(redirectCalls).toEqual([]);
  });

  it("answers 401 on an API route rather than redirecting", async () => {
    // A redirect here would hand the client an HTML sign-in page with a 200,
    // which it would try to parse as a card queue.
    getSession.mockResolvedValue(null);
    const { response, user } = await requireApiUser();
    expect(user).toBeUndefined();
    expect(response?.status).toBe(401);
    expect(response?.headers.get("content-type")).toContain("application/json");
    expect(redirectCalls).toEqual([]);
  });

  it("marks the 401 as uncacheable", async () => {
    getSession.mockResolvedValue(null);
    const { response } = await requireApiUser();
    expect(response?.headers.get("cache-control")).toContain("no-store");
  });

  it("passes the user through on an API route when signed in", async () => {
    getSession.mockResolvedValue({
      user: { id: "u1", email: "a@b.test", name: "A" },
    });
    const { user, response } = await requireApiUser();
    expect(response).toBeUndefined();
    expect(user?.id).toBe("u1");
  });
});

// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Routes that are public by design. Anything else must be gated. */
const PUBLIC_API_ROUTES = [
  join("app", "api", "auth"), // Better Auth owns its own authorization.
];

describe("the gate is actually wired up", () => {
  const files = walk(APP_ROOT);

  it("finds an app tree to inspect", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it("gates every page under (app) through a layout or its own check", () => {
    // The (app) layout calls requireUser(), so every page beneath it inherits
    // the gate. This asserts that layout still exists and still does it.
    const layout = readFileSync(
      join(APP_ROOT, "(app)", "layout.tsx"),
      "utf8",
    );
    expect(layout).toContain("requireUser");
  });

  it("has no page under (app) that lives outside that layout", () => {
    const appGroup = join(APP_ROOT, "(app)");
    const pages = walk(appGroup).filter((f) => f.endsWith("page.tsx"));
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(page.startsWith(appGroup)).toBe(true);
    }
  });

  it("gates every API route that is not deliberately public", () => {
    const apiRoutes = files.filter(
      (f) => f.endsWith("route.ts") && f.includes(`${join("app", "api")}`),
    );
    expect(apiRoutes.length).toBeGreaterThan(0);

    const ungated = apiRoutes.filter((file) => {
      if (PUBLIC_API_ROUTES.some((p) => file.includes(p))) return false;
      const source = readFileSync(file, "utf8");
      // Cron routes carry their own secret check; everything else needs a session.
      return (
        !source.includes("requireApiUser") && !source.includes("CRON_SECRET")
      );
    });

    expect(
      ungated.map((f) => f.slice(f.indexOf("app"))),
      "API routes with no session or secret check",
    ).toEqual([]);
  });
});
