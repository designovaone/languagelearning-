import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";

import { assertInviteValid, consumeInvite, InviteError } from "@/lib/auth/invite";
import { getDb } from "@/lib/db";
import * as authSchema from "@/lib/db/auth-schema";
import { courses, enrollments, profiles } from "@/lib/db/schema";
import { systemClock, type Clock } from "@/lib/time/clock";

/**
 * Better Auth owns `user`, `session`, `account` and `verification` through the
 * Drizzle adapter. Those four tables live in `auth-schema.ts` and **must not
 * gain columns of ours** — everything of ours hangs off `user.id` in
 * `profiles`, so a library upgrade stays a version bump (PLAN.md §4).
 *
 * `createAuth(db, clock)` rather than a module-level constant: the invite gate
 * is the security-critical part of M1, and it is only properly testable if the
 * whole auth instance can be built over in-process Postgres with a fixed clock.
 */

const DEFAULTS = {
  uiLocale: "en",
  baseLang: "en",
  timezone: "Europe/Berlin",
} as const;

export type CreateAuthOptions = {
  clock?: Clock;
  /** Defaults applied to the profile row created alongside a new user. */
  profileDefaults?: Partial<typeof DEFAULTS>;
  baseURL?: string;
  secret?: string;
};

// The Drizzle database type varies by driver (neon-serverless in production,
// PGlite in tests). Better Auth's adapter accepts any of them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAuth(db: any, options: CreateAuthOptions = {}) {
  const clock = options.clock ?? systemClock;
  const profileDefaults = { ...DEFAULTS, ...options.profileDefaults };

  return betterAuth({
    baseURL: options.baseURL ?? process.env.BETTER_AUTH_URL,
    secret: options.secret ?? process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: {
      enabled: true,
      // No email provider in the first phase, so nothing can be verified and
      // there is no self-service reset. Resets run through
      // `scripts/reset-password.ts` (PLAN.md §13).
      requireEmailVerification: false,
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    hooks: {
      /**
       * The gate itself. Runs before the user row is created, so an invalid
       * code never produces an account.
       */
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        try {
          await assertInviteValid(db, body.inviteCode, clock.now());
        } catch (error) {
          if (error instanceof InviteError) {
            // One message for every rejection reason. Distinguishing "unknown"
            // from "already used" would turn the endpoint into an oracle for
            // guessing valid codes.
            throw new APIError("FORBIDDEN", {
              message: "A valid invite code is required to sign up.",
              code: "INVITE_REQUIRED",
            });
          }
          throw error;
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          /**
           * Consume the invite and create the profile in one place, so a user
           * can never exist without either.
           */
          after: async (createdUser, ctx) => {
            const now = clock.now();
            const body = (ctx?.body ?? {}) as Record<string, unknown>;

            const won = await consumeInvite(
              db,
              body.inviteCode,
              createdUser.id,
              now,
            );
            if (!won) {
              // Lost a race for the same code. Fail loudly rather than leave a
              // half-registered account behind.
              await db
                .delete(authSchema.user)
                .where(eq(authSchema.user.id, createdUser.id));
              throw new APIError("FORBIDDEN", {
                message: "A valid invite code is required to sign up.",
                code: "INVITE_REQUIRED",
              });
            }

            const uiLocale = readLocale(body.uiLocale, profileDefaults.uiLocale);

            await db.insert(profiles).values({
              userId: createdUser.id,
              uiLocale,
              baseLang: readLocale(body.baseLang, uiLocale),
              timezone:
                typeof body.timezone === "string" && body.timezone.length > 0
                  ? body.timezone
                  : profileDefaults.timezone,
            });

            // Enrol, or the learner lands on a dashboard with no course and
            // nothing to study. The slug is checked against the courses that
            // actually exist rather than trusted from the request body.
            const requested =
              typeof body.courseSlug === "string" ? body.courseSlug : "";
            const available = await db
              .select({ id: courses.id, slug: courses.slug })
              .from(courses);
            const chosen =
              available.find((c: { slug: string }) => c.slug === requested) ??
              available.find(
                (c: { slug: string }) => c.slug === defaultCourseFor(uiLocale),
              );
            if (chosen) {
              await db
                .insert(enrollments)
                .values({ userId: createdUser.id, courseId: chosen.id })
                .onConflictDoNothing();
            }
          },
        },
      },
    },
  });
}

function readLocale(value: unknown, fallback: string): string {
  return value === "en" || value === "de" ? value : fallback;
}

/**
 * A learner reading the interface in German is learning English from German;
 * one reading it in English is learning Italian. Only a fallback — the signup
 * form asks directly.
 */
function defaultCourseFor(uiLocale: string): string {
  return uiLocale === "de" ? "en-from-de" : "it-from-en";
}

export type Auth = ReturnType<typeof createAuth>;

let cached: Auth | undefined;

/** The production instance. Lazy, so importing this file touches no environment. */
export function getAuth(): Auth {
  cached ??= createAuth(getDb());
  return cached;
}
