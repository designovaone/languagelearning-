"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth. Same origin as the app, so no baseURL is needed — and a
 * PWA is bound to its origin anyway (PLAN.md §13).
 */
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
