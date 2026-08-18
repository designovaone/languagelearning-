"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Item = { index: number; prompt: string };
type Answer = { index: number; answeredKnown: boolean; durationMs: number };

type Result = {
  estimatedSize: number;
  margin: number;
  hitRate: number;
  falseAlarmRate: number;
  correctedScore: number;
  seeded: { known: number; boundary: number; new: number };
};

type Phase = "intro" | "loading" | "running" | "submitting" | "done" | "error";

/**
 * Runs a sitting entirely on the device once the items have arrived.
 *
 * All items are fetched in one request and answered locally. Nothing is sent
 * until the end, so a tap is never waiting on the network — the whole test is
 * sixty taps and any per-tap latency is multiplied by sixty.
 *
 * The client is never told which prompts are traps. It reports index and
 * answer; the server knows the rest.
 */
export function AssessmentRunner() {
  const t = useTranslations("assessment");
  const [phase, setPhase] = useState<Phase>("intro");
  const [items, setItems] = useState<Item[]>([]);
  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const answers = useRef<Answer[]>([]);
  const shownAt = useRef<number>(0);

  const start = useCallback(async () => {
    setPhase("loading");
    const response = await fetch("/api/assessment", { method: "POST" });
    if (!response.ok) {
      setPhase("error");
      return;
    }
    const data = (await response.json()) as { assessmentId: string; items: Item[] };
    answers.current = [];
    setAssessmentId(data.assessmentId);
    setItems(data.items);
    setPosition(0);
    // performance.now() rather than the wall clock: this measures an elapsed
    // duration, and a monotonic source cannot produce a negative one if the
    // device's clock shifts mid-sitting. It also keeps the file inside the
    // project's clock rule (CLAUDE.md) — which flagged the banned form here
    // when it appeared only in this comment, exactly as it should.
    shownAt.current = performance.now();
    setPhase("running");
  }, []);

  const finish = useCallback(async () => {
    setPhase("submitting");
    const response = await fetch("/api/assessment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assessmentId, answers: answers.current }),
    });
    if (!response.ok) {
      setPhase("error");
      return;
    }
    setResult((await response.json()) as Result);
    setPhase("done");
  }, [assessmentId]);

  const record = useCallback(
    (answeredKnown: boolean) => {
      const item = items[position];
      if (!item) return;
      answers.current.push({
        index: item.index,
        answeredKnown,
        durationMs: Math.round(performance.now() - shownAt.current),
      });
      shownAt.current = performance.now();
      if (position + 1 >= items.length) {
        void finish();
      } else {
        setPosition(position + 1);
      }
    },
    [items, position, finish],
  );

  // Keyboard shortcuts, because this is sixty decisions and a mouse is slow.
  useEffect(() => {
    if (phase !== "running") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" || event.key === "1") record(false);
      if (event.key === "ArrowRight" || event.key === "2") record(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, record]);

  if (phase === "intro") {
    return (
      <button
        type="button"
        onClick={() => void start()}
        className="rounded-lg bg-neutral-900 px-4 py-3 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
      >
        {t("begin")}
      </button>
    );
  }

  if (phase === "loading" || phase === "submitting") {
    return <p className="text-sm text-neutral-600 dark:text-neutral-400">{t("working")}</p>;
  }

  if (phase === "error") {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("failed")}
        </p>
        <button type="button" onClick={() => void start()} className="text-sm underline">
          {t("begin")}
        </button>
      </div>
    );
  }

  if (phase === "done" && result) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          {/* A range, not a point. The instrument resolves to about ±550
              words, and a bare number would claim precision it does not have. */}
          <p className="text-3xl font-semibold tracking-tight">
            {Math.max(0, result.estimatedSize - result.margin).toLocaleString()}–
            {(result.estimatedSize + result.margin).toLocaleString()}
          </p>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{t("estimateBody")}</p>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Stat label={t("statClaimed")} value={`${Math.round(result.hitRate * 100)}%`} />
          <Stat label={t("statTraps")} value={`${Math.round(result.falseAlarmRate * 100)}%`} />
          <Stat label={t("statKnown")} value={result.seeded.known.toLocaleString()} />
          <Stat label={t("statNew")} value={result.seeded.new.toLocaleString()} />
        </dl>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{t("retakeHint")}</p>
        <Link href="/" className="text-sm underline">
          {t("backToDashboard")}
        </Link>
      </div>
    );
  }

  const item = items[position];
  return (
    <div className="flex flex-col gap-6">
      <div
        className="h-1 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800"
        role="progressbar"
        aria-valuenow={position + 1}
        aria-valuemin={1}
        aria-valuemax={items.length}
      >
        <div
          className="h-full bg-neutral-900 transition-[width] dark:bg-white"
          style={{ width: `${((position + 1) / items.length) * 100}%` }}
        />
      </div>

      <p className="text-xs tabular-nums text-neutral-500">
        {position + 1} / {items.length}
      </p>

      <p className="min-h-24 break-words text-center text-4xl font-medium tracking-tight">
        {item?.prompt}
      </p>

      <div className="grid grid-cols-2 gap-3">
        {/* Big targets: the design floor is a 375px phone and this is sixty taps. */}
        <button
          type="button"
          onClick={() => record(false)}
          className="rounded-lg border border-neutral-300 px-4 py-5 text-sm font-medium dark:border-neutral-700"
        >
          {t("dontKnow")}
        </button>
        <button
          type="button"
          onClick={() => record(true)}
          className="rounded-lg bg-neutral-900 px-4 py-5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          {t("know")}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="text-lg font-medium tabular-nums">{value}</dd>
    </div>
  );
}
