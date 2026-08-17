import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAuth } from "@/lib/auth";

/**
 * Session access for pages and route handlers.
 *
 * Two shapes on purpose: a page sends a person to the sign-in screen, an API
 * route answers 401. Returning a redirect from `/api/study/session` would make
 * an expired session look like a successful response containing an HTML login
 * page — which the client would try to parse as a card queue.
 *
 * `headers()` is async-only in Next 16.
 */

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  };
}

/** For pages. Sends a logged-out visitor to sign-in; never returns null. */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect(
      returnTo ? `/sign-in?next=${encodeURIComponent(returnTo)}` : "/sign-in",
    );
  }
  return user;
}

/** For route handlers. Returns a 401 Response instead of redirecting. */
export async function requireApiUser(): Promise<
  { user: SessionUser; response?: never } | { user?: never; response: Response }
> {
  const user = await getSessionUser();
  if (!user) {
    return {
      response: Response.json(
        { error: "unauthenticated" },
        { status: 401, headers: { "cache-control": "no-store" } },
      ),
    };
  }
  return { user };
}
