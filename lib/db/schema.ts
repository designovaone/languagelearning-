import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

export * from "./auth-schema";

/**
 * The application schema (PLAN.md §4).
 *
 * Rules that hold across every table here:
 *
 * - **Every timestamp is `timestamptz`.** It stores an instant. `local_date` is
 *   a plain `date` computed in the *learner's* timezone, never the server's.
 * - **`source` and `license` appear on every content table.** A missing
 *   attribution is a licence breach, so the loader fails rather than guesses.
 * - **Nothing of ours is added to Better Auth's tables.** Everything hangs off
 *   `user.id`, starting with `profiles`.
 */

const userId = () =>
  text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" });

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const profiles = pgTable("profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  uiLocale: text("ui_locale").notNull().default("en"),
  baseLang: text("base_lang").notNull(),
  /** IANA zone, e.g. Europe/Berlin. Every local_date is computed in this. */
  timezone: text("timezone").notNull().default("Europe/Berlin"),
  dailyNewLimit: integer("daily_new_limit").notNull().default(15),
  dailyReviewLimit: integer("daily_review_limit").notNull().default(120),
  sessionTargetCards: integer("session_target_cards").notNull().default(60),
  nudgeHourLocal: smallint("nudge_hour_local").notNull().default(19),
  // --- extensibility columns, taken at M1 so no door closes (PLAN.md §2) ---
  /** Groups the shared streak. Null = the default group. */
  groupId: text("group_id"),
  role: text("role").notNull().default("user"),
  /** GDPR Art. 17. Soft delete first, hard delete via /api/me/export path. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const invites = pgTable("invites", {
  code: text("code").primaryKey(),
  createdBy: text("created_by").references(() => user.id, {
    onDelete: "set null",
  }),
  usedBy: text("used_by").references(() => user.id, { onDelete: "set null" }),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export const courses = pgTable("courses", {
  id: text("id").primaryKey(),
  targetLang: text("target_lang").notNull(),
  baseLang: text("base_lang").notNull(),
  /** e.g. 'it-from-en' */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  license: text("license").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Generic on purpose. Band 1 is 'A1' (scheme 'cefr-j') for English and
 * 'Fondamentale' (scheme 'nvdb') for Italian — different grading systems, one
 * table. A language with no curated list uses scheme 'frequency'.
 */
export const bands = pgTable(
  "bands",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    name: text("name").notNull(),
    scheme: text("scheme").notNull(),
  },
  (t) => [unique("bands_course_number_unq").on(t.courseId, t.number)],
);

export const audioAssets = pgTable("audio_assets", {
  id: text("id").primaryKey(),
  blobUrl: text("blob_url").notNull(),
  bytes: integer("bytes").notNull(),
  voice: text("voice").notNull(),
  source: text("source").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const words = pgTable(
  "words",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    bandId: text("band_id").references(() => bands.id, {
      onDelete: "set null",
    }),
    /**
     * Where the grading came from ('cefr-j' | 'nvdb' | 'frequency'), so a
     * curated grading can be swapped for frequency without rebuilding the deck.
     */
    bandSource: text("band_source").notNull(),
    freqRank: integer("freq_rank"),
    lemma: text("lemma").notNull(),
    pos: text("pos"),
    gender: text("gender"),
    translations: jsonb("translations").notNull(),
    primarySense: text("primary_sense"),
    topic: text("topic"),
    /** Nullable: only present where an open graded list supplies it. */
    cefr: text("cefr"),
    audioAssetId: text("audio_asset_id").references(() => audioAssets.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull(),
    license: text("license").notNull(),
  },
  (t) => [
    unique("words_course_lemma_pos_unq").on(t.courseId, t.lemma, t.pos),
    index("words_course_rank_idx").on(t.courseId, t.freqRank),
  ],
);

export const sentences = pgTable(
  "sentences",
  {
    id: text("id").primaryKey(),
    wordId: text("word_id")
      .notNull()
      .references(() => words.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    translation: text("translation").notNull(),
    audioAssetId: text("audio_asset_id").references(() => audioAssets.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull(),
    license: text("license").notNull(),
  },
  (t) => [index("sentences_word_idx").on(t.wordId)],
);

export const grammarItems = pgTable("grammar_items", {
  id: text("id").primaryKey(),
  courseId: text("course_id")
    .notNull()
    .references(() => courses.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  explanation: jsonb("explanation").notNull(),
  examples: jsonb("examples").notNull(),
  /** Everything generated lands 'pending' and needs keep/discard (PLAN.md §10). */
  status: text("status").notNull().default("pending"),
  sourceReviewIds: jsonb("source_review_ids"),
  createdBy: text("created_by").notNull().default("nightly"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Study
// ---------------------------------------------------------------------------

export const enrollments = pgTable(
  "enrollments",
  {
    userId: userId(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.courseId] }),
    unique("enrollments_user_course_unq").on(t.userId, t.courseId),
  ],
);

export const studySessions = pgTable(
  "study_sessions",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Plain date, computed in the learner's timezone. */
    localDate: date("local_date").notNull(),
    cardsDone: integer("cards_done").notNull().default(0),
    seconds: integer("seconds").notNull().default(0),
  },
  (t) => [index("study_sessions_user_date_idx").on(t.userId, t.localDate)],
);

/**
 * FSRS state per **(user × word × exercise type)**. Recognition, production and
 * listening are different skills; one shared state averages three numbers into
 * one and weakens the premise (PLAN.md §2).
 */
export const cards = pgTable(
  "cards",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    wordId: text("word_id").references(() => words.id, { onDelete: "cascade" }),
    grammarItemId: text("grammar_item_id").references(() => grammarItems.id, {
      onDelete: "cascade",
    }),
    /** recognition | production | listening | sentence | grammar */
    exerciseType: text("exercise_type").notNull(),

    // --- ts-fsrs Card, one column per field, no JSON blob ---
    due: timestamp("due", { withTimezone: true }).notNull(),
    /**
     * **`double precision`, not `real`, and the difference is load-bearing.**
     *
     * PLAN.md §7.4 requires that replaying a review log reproduces the same
     * card states however the flushes were batched. A `real` column is float4:
     * a value written at a batch boundary comes back rounded to about seven
     * significant digits, so the next review starts from a slightly different
     * number than it would have inside one batch. The states then diverge in
     * the last few bits — enough to fail the invariant, far too little to
     * notice in a schedule. Found by the invariant test, which is the only
     * thing that could have found it.
     *
     * A JavaScript number *is* a float8, so this column round-trips exactly.
     */
    stability: doublePrecision("stability").notNull().default(0),
    difficulty: doublePrecision("difficulty").notNull().default(0),
    /** Deprecated in ts-fsrs 6.0. Kept because 5.x still writes it; never read. */
    elapsedDays: integer("elapsed_days").notNull().default(0),
    scheduledDays: integer("scheduled_days").notNull().default(0),
    learningSteps: integer("learning_steps").notNull().default(0),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    /** New 0, Learning 1, Review 2, Relearning 3 */
    state: smallint("state").notNull().default(0),
    lastReview: timestamp("last_review", { withTimezone: true }),

    /** Production and listening start suspended and activate on gating. */
    suspended: boolean("suspended").notNull().default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("cards_user_word_type_unq").on(
      t.userId,
      t.wordId,
      t.exerciseType,
    ),
    uniqueIndex("cards_user_grammar_type_unq").on(
      t.userId,
      t.grammarItemId,
      t.exerciseType,
    ),
    // The hot query: due cards for one learner.
    index("cards_user_due_idx")
      .on(t.userId, t.due)
      .where(sql`${t.suspended} = false`),
    check(
      "cards_exactly_one_target",
      sql`(${t.wordId} is not null)::int + (${t.grammarItemId} is not null)::int = 1`,
    ),
    check(
      "cards_state_range",
      sql`${t.state} >= 0 and ${t.state} <= 3`,
    ),
  ],
);

/**
 * The insurance that makes the grade mapping reversible: the raw signal is
 * always stored, so the grade is a pure function of it and the entire history
 * can be replayed through a new mapping (PLAN.md §7.3).
 */
export const reviews = pgTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: userId(),
    sessionId: text("session_id").references(() => studySessions.id, {
      onDelete: "set null",
    }),

    // --- raw signal ---
    wasCorrect: boolean("was_correct").notNull(),
    durationMs: integer("duration_ms").notNull(),
    answerGiven: text("answer_given"),
    hintUsed: boolean("hint_used").notNull().default(false),

    // --- derived ---
    /** ts-fsrs Rating: Manual 0, Again 1, Hard 2, Good 3, Easy 4. */
    rating: smallint("rating").notNull(),

    // --- ts-fsrs before/after, so a replay can be verified ---
    stateBefore: smallint("state_before").notNull(),
    // `double precision` for the same reason as on `cards`: these are what a
    // replay is checked against, and a check that is right to seven digits is
    // not a check.
    stabilityBefore: doublePrecision("stability_before").notNull(),
    difficultyBefore: doublePrecision("difficulty_before").notNull(),
    dueBefore: timestamp("due_before", { withTimezone: true }).notNull(),
    stabilityAfter: doublePrecision("stability_after").notNull(),
    difficultyAfter: doublePrecision("difficulty_after").notNull(),
    scheduledDays: integer("scheduled_days").notNull(),
    elapsedDays: integer("elapsed_days").notNull(),

    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
    /** 'drill' | 'assessment' | 'replay' */
    source: text("source").notNull().default("drill"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
  },
  (t) => [
    index("reviews_user_reviewed_idx").on(t.userId, t.reviewedAt),
    index("reviews_card_idx").on(t.cardId),
    check("reviews_rating_range", sql`${t.rating} >= 0 and ${t.rating} <= 4`),
  ],
);

/** What the grammar mining reads (PLAN.md §10). */
export const answerAnalysis = pgTable("answer_analysis", {
  reviewId: text("review_id")
    .primaryKey()
    .references(() => reviews.id, { onDelete: "cascade" }),
  errorType: text("error_type").notNull(),
  expectedForm: text("expected_form"),
  givenForm: text("given_form"),
  explanationBaseLang: text("explanation_base_lang"),
  model: text("model").notNull(),
  confidence: real("confidence"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Habit
// ---------------------------------------------------------------------------

export const dailyActivity = pgTable(
  "daily_activity",
  {
    userId: userId(),
    localDate: date("local_date").notNull(),
    cardsDone: integer("cards_done").notNull().default(0),
    seconds: integer("seconds").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.localDate] })],
);

export const streakFreezes = pgTable(
  "streak_freezes",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    localDate: date("local_date").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("streak_freezes_user_date_unq").on(t.userId, t.localDate)],
);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: userId(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  ua: text("ua"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  failureCount: integer("failure_count").notNull().default(0),
});

/** One row per user per local day, so extra cron firings are no-ops. */
export const nudgeLog = pgTable(
  "nudge_log",
  {
    userId: userId(),
    localDate: date("local_date").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.localDate] })],
);

/** Powers the staleness warning when a scheduler silently stops (PLAN.md §9.3). */
export const cronRuns = pgTable(
  "cron_runs",
  {
    id: text("id").primaryKey(),
    job: text("job").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ok: boolean("ok").notNull().default(true),
    note: text("note"),
  },
  (t) => [index("cron_runs_job_started_idx").on(t.job, t.startedAt)],
);

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export const assessments = pgTable(
  "assessments",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    takenAt: timestamp("taken_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    estimatedSize: integer("estimated_size"),
    hitRate: real("hit_rate"),
    falseAlarmRate: real("false_alarm_rate"),
    correctedScore: real("corrected_score"),
    bandCurve: jsonb("band_curve"),
  },
  (t) => [index("assessments_user_taken_idx").on(t.userId, t.takenAt)],
);

export const assessmentItems = pgTable(
  "assessment_items",
  {
    id: text("id").primaryKey(),
    assessmentId: text("assessment_id")
      .notNull()
      .references(() => assessments.id, { onDelete: "cascade" }),
    wordId: text("word_id").references(() => words.id, { onDelete: "set null" }),
    /** Generated, never borrowed — published item lists work exactly once. */
    pseudoword: text("pseudoword"),
    isReal: boolean("is_real").notNull(),
    answeredKnown: boolean("answered_known"),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    index("assessment_items_assessment_idx").on(t.assessmentId),
    check(
      "assessment_items_exactly_one_target",
      sql`(${t.wordId} is not null)::int + (${t.pseudoword} is not null)::int = 1`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

/** The tier-1 buffer: content pre-generated so the card path never waits. */
export const generatedContent = pgTable(
  "generated_content",
  {
    id: text("id").primaryKey(),
    wordId: text("word_id").references(() => words.id, { onDelete: "cascade" }),
    grammarItemId: text("grammar_item_id").references(() => grammarItems.id, {
      onDelete: "cascade",
    }),
    exerciseType: text("exercise_type").notNull(),
    payload: jsonb("payload").notNull(),
    model: text("model").notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("generated_content_word_type_idx").on(t.wordId, t.exerciseType),
    check(
      "generated_content_exactly_one_target",
      sql`(${t.wordId} is not null)::int + (${t.grammarItemId} is not null)::int = 1`,
    ),
  ],
);

/** Shows what the AI actually costs rather than what was estimated. */
export const aiCalls = pgTable(
  "ai_calls",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    tier: smallint("tier").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    latencyMs: integer("latency_ms"),
    ok: boolean("ok").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ai_calls_user_created_idx").on(t.userId, t.createdAt)],
);
