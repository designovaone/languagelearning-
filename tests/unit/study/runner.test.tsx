// @vitest-environment jsdom
import { NextIntlClientProvider } from "next-intl";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "@/lib/i18n/messages/en.json";

import { StudyRunner } from "@/app/(app)/study/study-runner";

/**
 * **The M4 exit criterion, measured: "card-to-card issues zero network
 * requests" (PLAN.md §11).**
 *
 * This is the property the whole prefetch design exists for, and it is the one
 * that cannot be checked by reading the code — a `fetch` added anywhere in the
 * answer path would look perfectly reasonable in review and would only show up
 * as a stutter on a train.
 *
 * So the test counts requests. Everything else here is secondary.
 */

const CARDS = Array.from({ length: 12 }, (_, index) => ({
  cardId: `card_${index}`,
  wordId: `word_${index}`,
  kind: index === 0 ? ("boundary" as const) : ("fresh" as const),
  exerciseType: "recognition",
  prompt: `parola${index}`,
  pos: "noun",
  gender: null,
  translations: [`word${index}`],
  primarySense: `word${index}`,
}));

function session(cards = CARDS) {
  return {
    sessionId: "s_1",
    startedAt: "2026-08-18T09:00:00.000Z",
    localDate: "2026-08-18",
    cards,
    medianMs: { recognition: null },
    counts: { review: 0, boundary: 1, fresh: cards.length - 1 },
    today: { cardsDone: 0, seconds: 0 },
    nextDue: null,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mountRunner() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StudyRunner />
    </NextIntlClientProvider>,
  );
}

/** URLs requested so far, in order. */
function requested(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/api/study/session")) {
      return new Response(JSON.stringify(session()), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ applied: 1, skipped: 0, today: { cardsDone: 1, seconds: 4 } }), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function answer(user: ReturnType<typeof userEvent.setup>, text: string) {
  const field = screen.getByLabelText("Type your answer");
  await user.clear(field);
  await user.type(field, text);
  await user.click(screen.getByRole("button", { name: "Check" }));
}

describe("the drill runs on the device", () => {
  it("fetches the session exactly once and then goes quiet", async () => {
    const user = userEvent.setup();
    mountRunner();
    await screen.findByText("parola0");
    expect(requested()).toEqual(["/api/study/session"]);

    // Nine correct answers — one short of a flush. Not a single further
    // request may leave the device.
    for (let index = 0; index < 9; index++) {
      await answer(user, `word${index}`);
      await waitFor(() => expect(screen.getByText(`parola${index + 1}`)).toBeTruthy());
    }

    expect(requested()).toEqual(["/api/study/session"]);
  }, 30_000);

  it("flushes in the background once the buffer fills, without blocking the card", async () => {
    const user = userEvent.setup();
    mountRunner();
    await screen.findByText("parola0");

    for (let index = 0; index < 10; index++) {
      await answer(user, `word${index}`);
      await waitFor(() => expect(screen.getByText(`parola${index + 1}`)).toBeTruthy());
    }

    await waitFor(() => expect(requested()).toContain("/api/study/reviews"));
    // One flush, not ten.
    expect(requested().filter((url) => url === "/api/study/reviews")).toHaveLength(1);
    // And the learner is on card 11 regardless.
    expect(screen.getByText("parola10")).toBeTruthy();
  }, 30_000);

  it("sends the raw signal and an idempotency key, and no grade", async () => {
    const user = userEvent.setup();
    mountRunner();
    await screen.findByText("parola0");

    for (let index = 0; index < 10; index++) {
      await answer(user, index === 0 ? "wrong-on-purpose" : `word${index}`);
      if (index === 0) {
        await user.click(screen.getByRole("button", { name: "Continue" }));
      }
      await waitFor(() => expect(screen.getByText(`parola${index + 1}`)).toBeTruthy());
    }

    await waitFor(() => expect(requested()).toContain("/api/study/reviews"));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("reviews"));
    const body = JSON.parse(String((call?.[1] as RequestInit).body));

    expect(body.sessionId).toBe("s_1");
    expect(body.reviews).toHaveLength(10);
    const first = body.reviews[0];
    expect(first.wasCorrect).toBe(false);
    expect(first.answerGiven).toBe("wrong-on-purpose");
    expect(first.idempotencyKey).toBe("s_1:card_0:1");
    expect(typeof first.durationMs).toBe("number");
    expect(typeof first.offsetMs).toBe("number");
    // The client never computes FSRS state (PLAN.md §2).
    expect(first).not.toHaveProperty("rating");
    expect(first).not.toHaveProperty("due");
  }, 30_000);
});

describe("what the learner sees", () => {
  it("marks a correct answer and moves on by itself", async () => {
    const user = userEvent.setup();
    mountRunner();
    await screen.findByText("parola0");
    await answer(user, "word0");
    expect(screen.getByText("Correct")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("parola1")).toBeTruthy());
  });

  it("shows the expected answer on a wrong one and waits", async () => {
    const user = userEvent.setup();
    mountRunner();
    await screen.findByText("parola0");
    await answer(user, "nonsense");

    expect(screen.getByText("Not quite")).toBeTruthy();
    expect(screen.getByText("word0")).toBeTruthy();
    // Still on the same card until the learner says go.
    expect(screen.getByText("parola0")).toBeTruthy();
  });

  it("brings a wrong card back later in the same session", async () => {
    const user = userEvent.setup();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <StudyRunner />
      </NextIntlClientProvider>,
    );
    await screen.findByText("parola0");
    await answer(user, "nonsense");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("parola1");

    // 12 cards, one answered wrong, so the queue is now 13 long.
    expect(screen.getByText("2 of 13")).toBeTruthy();
  });

  it("says which cards are new and which the learner may already know", async () => {
    const user = userEvent.setup();
    mountRunner();
    await screen.findByText("parola0");
    expect(screen.getByText("You may know this one")).toBeTruthy();

    await answer(user, "word0");
    await waitFor(() => expect(screen.getByText("parola1")).toBeTruthy());
    expect(screen.getByText("New word")).toBeTruthy();
  });

  it("offers a hint that masks the answer", async () => {
    const user = userEvent.setup();
    mountRunner();
    await screen.findByText("parola0");
    await user.click(screen.getByRole("button", { name: "Hint" }));
    expect(screen.getByText("w····")).toBeTruthy();
  });

  it("shows 'done for today' when nothing is due", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(session([])), {
          headers: { "content-type": "application/json" },
        }),
    );
    mountRunner();
    await screen.findByText("Done for today");
    // A designed screen, not an empty state (PLAN.md §7.2).
    expect(screen.getByText(/Coming back tomorrow/)).toBeTruthy();
  });

  it("says so when the session cannot be loaded, rather than showing a blank drill", async () => {
    fetchMock.mockImplementation(async () => new Response("nope", { status: 500 }));
    mountRunner();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not load/);
  });
});
