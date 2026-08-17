import * as schema from "@/lib/db/schema";

import type { TestDatabase } from "./pglite";

/**
 * The smallest set of rows that makes a card legal: a user, a profile, a
 * course, a band and a word. Deliberately tiny — fixtures stay small and
 * committed (PLAN.md §12).
 */
export type Seed = {
  userId: string;
  courseId: string;
  bandId: string;
  wordIds: string[];
};

export async function seedMinimal(
  db: TestDatabase,
  opts: { userId?: string; words?: number; timezone?: string } = {},
): Promise<Seed> {
  const userId = opts.userId ?? "u_test";
  const courseId = `c_${userId}`;
  const bandId = `b_${userId}`;
  const wordCount = opts.words ?? 3;

  await db.insert(schema.user).values({
    id: userId,
    name: "Test Learner",
    email: `${userId}@example.test`,
    emailVerified: false,
    updatedAt: EPOCH,
  });

  await db.insert(schema.profiles).values({
    userId,
    uiLocale: "en",
    baseLang: "en",
    timezone: opts.timezone ?? "Europe/Berlin",
  });

  await db.insert(schema.courses).values({
    id: courseId,
    targetLang: "it",
    baseLang: "en",
    slug: `it-from-en-${userId}`,
    name: "Italian from English",
    source: "test-fixture",
    license: "CC0-1.0",
  });

  await db.insert(schema.bands).values({
    id: bandId,
    courseId,
    number: 1,
    name: "Fondamentale",
    scheme: "nvdb",
  });

  const wordIds: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    const id = `w_${userId}_${i}`;
    wordIds.push(id);
    await db.insert(schema.words).values({
      id,
      courseId,
      bandId,
      bandSource: "nvdb",
      freqRank: i + 1,
      lemma: `lemma${i}`,
      pos: "noun",
      translations: [`translation${i}`],
      source: "test-fixture",
      license: "CC0-1.0",
    });
  }

  await db.insert(schema.enrollments).values({ userId, courseId });

  return { userId, courseId, bandId, wordIds };
}

/** A fixed instant, so no fixture ever reads the wall clock. */
export const EPOCH = new Date("2026-01-01T00:00:00.000Z");
