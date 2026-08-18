"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { expectedAnswer, hintFor, isAccepted } from "@/lib/study/normalize";

/**
 * The drill (PLAN.md §7).
 *
 * ### The one rule this component exists to keep
 *
 * **Going from one card to the next issues no network request.** Everything
 * needed to show a card, judge an answer and move on arrived in the single
 * prefetch: the prompts, the accepted answers, the learner's pace baseline.
 * Answers accumulate in a ref and are flushed in the background, never awaited
 * by anything the learner is waiting on.
 *
 * That is what makes the drill usable on a phone with two bars, and it is the
 * measured exit criterion for M4 rather than an aspiration.
 *
 * The client never computes FSRS state. It reports raw signal — right or
 * wrong, how long, whether a hint was taken — and the server decides what that
 * means (PLAN.md §2).
 */

type Card = {
  cardId: string;
  wordId: string;
  kind: "review" | "boundary" | "fresh";
  exerciseType: string;
  prompt: string;
  pos: string | null;
  gender: string | null;
  translations: string[];
  primarySense: string | null;
};

type Session = {
  sessionId: string;
  startedAt: string;
  localDate: string;
  cards: Card[];
  medianMs: Record<string, number | null>;
  counts: { review: number; boundary: number; fresh: number };
  today: { cardsDone: number; seconds: number };
  nextDue: string | null;
};

type BufferedReview = {
  cardId: string;
  idempotencyKey: string;
  wasCorrect: boolean;
  durationMs: number;
  answerGiven: string | null;
  hintUsed: boolean;
  offsetMs: number;
};

type Phase = "loading" | "running" | "done" | "empty" | "error";

/** Answers per background flush. Small enough that a lost tab costs little. */
const FLUSH_EVERY = 10;
/** How long a correct answer stays on screen before the next card. */
const CORRECT_MS = 550;

export function StudyRunner() {
  const t = useTranslations();
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [queue, setQueue] = useState<Card[]>([]);
  const [position, setPosition] = useState(0);
  const [answer, setAnswer] = useState("");
  const [verdict, setVerdict] = useState<"correct" | "wrong" | null>(null);
  const [hintShown, setHintShown] = useState(false);
  const [done, setDone] = useState(0);

  const buffer = useRef<BufferedReview[]>([]);
  const attempts = useRef(new Map<string, number>());
  const epoch = useRef(0);
  const shownAt = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // --- flushing -----------------------------------------------------------
  //
  // Serialised through a single promise chain. Two overlapping flushes would
  // be safe on the server — every review carries an idempotency key — but
  // chaining keeps `reviewed_at` ordering intact and stops a slow connection
  // from stacking up requests.
  const flush = useCallback(
    (keepalive = false) => {
      if (!session || buffer.current.length === 0) return;
      const batch = buffer.current;
      buffer.current = [];
      const send = async () => {
        try {
          await fetch("/api/study/reviews", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: session.sessionId, reviews: batch }),
            keepalive,
          });
        } catch {
          // Put them back. The buffer is the only copy, and an idempotency key
          // makes a re-send free — so losing the network must cost nothing but
          // a retry later.
          buffer.current = [...batch, ...buffer.current];
        }
      };
      inFlight.current = (inFlight.current ?? Promise.resolve()).then(send);
    },
    [session],
  );

  // --- loading ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/study/session");
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as Session;
        if (cancelled) return;
        // The clock starts when the payload lands, not when the request left:
        // every offset is measured against the same origin on this device and
        // anchored to the server's `startedAt` when it is written.
        epoch.current = performance.now();
        shownAt.current = epoch.current;
        setSession(data);
        setQueue(data.cards);
        setPhase(data.cards.length === 0 ? "empty" : "running");
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A backgrounded tab on iOS may never come back. Flush on the way out.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [flush]);

  const card = queue[position];

  useEffect(() => {
    if (phase === "running") input.current?.focus();
  }, [phase, position]);

  const advance = useCallback(
    (wasCorrect: boolean) => {
      setVerdict(null);
      setAnswer("");
      setHintShown(false);
      shownAt.current = performance.now();
      setDone((count) => count + 1);

      // A wrong card comes back inside the same session: FSRS's learning steps
      // want it within minutes, and the learner gets the correction while the
      // word is still in mind. The server's schedule remains the truth — this
      // only decides what the next few minutes look like.
      const wrong = wasCorrect ? null : queue[position];
      const next = wrong ? [...queue, wrong] : queue;

      // Ending the session is decided here, in the event that ends it, rather
      // than in an effect watching the position. An effect would set state
      // during render-commit and cascade, and — more to the point — "the
      // session ended" is something that *happened*, not something that
      // becomes true on its own.
      if (position + 1 >= next.length) {
        flush();
        setPhase("done");
        return;
      }

      if (wrong) setQueue(next);
      setPosition(position + 1);
    },
    [position, queue, flush],
  );

  const submit = useCallback(
    (forceWrong = false) => {
      if (!card || verdict !== null) return;
      const correct = !forceWrong && isAccepted(answer, card);
      const durationMs = Math.round(performance.now() - shownAt.current);
      const attempt = (attempts.current.get(card.cardId) ?? 0) + 1;
      attempts.current.set(card.cardId, attempt);

      buffer.current.push({
        cardId: card.cardId,
        // Deterministic, so re-sending a batch after a failed request is a
        // no-op rather than a second review.
        idempotencyKey: `${session?.sessionId ?? "none"}:${card.cardId}:${attempt}`,
        wasCorrect: correct,
        durationMs,
        answerGiven: answer.trim() ? answer.trim().slice(0, 500) : null,
        hintUsed: hintShown,
        offsetMs: Math.max(0, Math.round(performance.now() - epoch.current)),
      });

      if (buffer.current.length >= FLUSH_EVERY) flush();

      setVerdict(correct ? "correct" : "wrong");
      // A correct answer moves on by itself; a wrong one waits, because the
      // expected answer is the only teaching this exercise does.
      if (correct) window.setTimeout(() => advance(true), CORRECT_MS);
    },
    [card, verdict, answer, hintShown, session, flush, advance],
  );

  if (phase === "loading") {
    return <p className="text-sm text-neutral-600 dark:text-neutral-400">{t("study.loading")}</p>;
  }

  if (phase === "error") {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {t("study.failed")}
      </p>
    );
  }

  if (phase === "empty" || phase === "done") {
    return (
      <DoneForToday
        cardsDone={(session?.today.cardsDone ?? 0) + done}
        seconds={session?.today.seconds ?? 0}
        nextDue={session?.nextDue ?? null}
        startedAt={session?.startedAt ?? null}
      />
    );
  }

  if (!card) return null;

  const expected = expectedAnswer(card);

  return (
    <div className="flex flex-col gap-6">
      <div
        className="h-1 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800"
        role="progressbar"
        aria-valuenow={position + 1}
        aria-valuemin={1}
        aria-valuemax={queue.length}
      >
        <div
          className="h-full bg-neutral-900 transition-[width] dark:bg-white"
          style={{ width: `${((position + 1) / queue.length) * 100}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="tabular-nums text-neutral-500">
          {t("study.progress", { done: position + 1, total: queue.length })}
        </span>
        {card.kind !== "review" && (
          <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
            {card.kind === "boundary" ? t("study.kindBoundary") : t("study.kindNew")}
          </span>
        )}
      </div>

      <div className="flex flex-col items-center gap-1">
        <p className="break-words text-center text-4xl font-medium tracking-tight">
          {card.prompt}
        </p>
        {(card.pos || card.gender) && (
          <p className="text-xs text-neutral-500">
            {[card.pos, card.gender].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (verdict === "wrong") advance(false);
          else submit();
        }}
        className="flex flex-col gap-3"
      >
        <input
          ref={input}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          readOnly={verdict !== null}
          placeholder={t("study.typeAnswer")}
          aria-label={t("study.typeAnswer")}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="w-full rounded-lg border border-neutral-300 px-4 py-4 text-lg outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-white"
        />

        {verdict === null && hintShown && (
          <p className="text-center text-sm tracking-widest text-neutral-500">{hintFor(card)}</p>
        )}

        {verdict === "correct" && (
          <p role="status" className="text-center text-sm font-medium text-green-600 dark:text-green-400">
            {t("study.correct")}
          </p>
        )}

        {verdict === "wrong" && (
          <div role="status" className="flex flex-col gap-1 text-center">
            <p className="text-sm font-medium text-red-600 dark:text-red-400">
              {t("study.incorrect")}
            </p>
            <p className="text-lg">{expected}</p>
          </div>
        )}

        {verdict === null ? (
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setHintShown(true)}
              className="rounded-lg border border-neutral-300 px-3 py-3 text-sm dark:border-neutral-700"
            >
              {t("study.hint")}
            </button>
            <button
              type="button"
              onClick={() => submit(true)}
              className="rounded-lg border border-neutral-300 px-3 py-3 text-sm dark:border-neutral-700"
            >
              {t("study.showAnswer")}
            </button>
            <button
              type="submit"
              className="rounded-lg bg-neutral-900 px-3 py-3 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              {t("study.check")}
            </button>
          </div>
        ) : (
          verdict === "wrong" && (
            <button
              type="submit"
              className="rounded-lg bg-neutral-900 px-4 py-4 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              {t("study.continue")}
            </button>
          )
        )}
      </form>
    </div>
  );
}

/**
 * The screen that is the point of the whole project (PLAN.md §7.2).
 *
 * Nothing is due, so the app says so and offers no grind. It carries the day's
 * numbers because an empty state that says nothing reads like a failure, and
 * because this is the moment the learner sees the complaint being fixed — a
 * commercial app whose revenue needs the session to continue structurally
 * cannot offer this screen.
 */
function DoneForToday({
  cardsDone,
  seconds,
  nextDue,
  startedAt,
}: {
  cardsDone: number;
  seconds: number;
  nextDue: string | null;
  /**
   * The server's own timestamp for this session. Used as "now" for the
   * same-day comparison below, so the label does not depend on a device clock
   * that may be wrong — and so this file keeps to the project's clock rule.
   */
  startedAt: string | null;
}) {
  const t = useTranslations();
  const minutes = Math.max(1, Math.round(seconds / 60));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">{t("done.title")}</h2>
        <p className="text-neutral-600 dark:text-neutral-400">{t("done.body")}</p>
      </div>

      {cardsDone > 0 && (
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex flex-col gap-0.5 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <dt className="text-xs text-neutral-500">{t("done.todayLabel")}</dt>
            <dd className="text-lg font-medium tabular-nums">
              {t("done.cardsReviewed", { count: cardsDone })}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <dt className="text-xs text-neutral-500">{t("done.timeLabel")}</dt>
            <dd className="text-lg font-medium tabular-nums">
              {t("done.minutes", { count: minutes })}
            </dd>
          </div>
        </dl>
      )}

      {nextDue && startedAt && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t("done.nextDue", {
            when: (() => {
              const due = new Date(nextDue);
              const from = new Date(startedAt);
              // A learning step brings a card back in ten minutes; rendering
              // that as today's date is true and useless.
              return due.toDateString() === from.toDateString()
                ? due.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
                : due.toLocaleDateString();
            })(),
          })}
        </p>
      )}

      <Link href="/" className="text-sm underline">
        {t("nav.dashboard")}
      </Link>
    </div>
  );
}
