import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/lib/auth";

/**
 * Better Auth's own routes. Node runtime: the proxy convention does not support
 * edge, and later work (`web-push`) needs Node anyway (PLAN.md §13).
 */
export const runtime = "nodejs";

export const { GET, POST } = toNextJsHandler(getAuth().handler);
