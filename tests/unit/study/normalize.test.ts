import { describe, expect, it } from "vitest";

import {
  MIN_PREFIX,
  acceptedForms,
  expectedAnswer,
  hintFor,
  isAccepted,
  normalize,
} from "@/lib/study/normalize";

/**
 * PLAN.md §7.3. Grading a typed answer, on the device, with no network.
 *
 * Most of the cases below are taken from words that are really in the live
 * deck, because the interesting failures are not "does exact match work" but
 * "does this cope with what stage 4 and stage 5 actually wrote".
 */

const word = (translations: string[], primarySense: string | null = null) => ({
  translations,
  primarySense,
});

describe("normalisation", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(normalize("  The House!  ")).toBe("the house");
    expect(normalize("to run,")).toBe("to run");
  });

  it("ignores accents", () => {
    // Typed on a phone keyboard the learner has not switched. "cafe" for
    // "café" is not a vocabulary mistake.
    expect(normalize("café")).toBe(normalize("cafe"));
    expect(normalize("perché")).toBe("perche");
    expect(normalize("Grüße")).toBe("grusse");
  });

  it("folds ß to ss", () => {
    // One of the two courses has German as its base language, so answers are
    // typed in German. Both spellings are correct, and ß is a long-press away
    // on a phone keyboard.
    expect(normalize("Straße")).toBe(normalize("Strasse"));
    expect(isAccepted("Strasse", word(["Straße"]))).toBe(true);
    expect(isAccepted("Straße", word(["Strasse"]))).toBe(true);
  });

  it("collapses repeated whitespace", () => {
    expect(normalize("a   lot   of")).toBe("a lot of");
  });

  it("returns empty for input with no letters", () => {
    expect(normalize("  ...  ")).toBe("");
  });
});

describe("accepting an answer", () => {
  it("accepts the plain translation", () => {
    expect(isAccepted("house", word(["house"]))).toBe(true);
  });

  it("rejects a different word", () => {
    expect(isAccepted("horse", word(["house"]))).toBe(false);
  });

  it("rejects an empty answer", () => {
    expect(isAccepted("", word(["house"]))).toBe(false);
    expect(isAccepted("   ", word(["house"]))).toBe(false);
  });

  it("accepts any sense from a multi-sense list", () => {
    // A real `translations` entry from the live deck. Requiring the learner to
    // reproduce the punctuation would be absurd.
    const per = word(["away, for, per, at, on, to, in, into"]);
    for (const answer of ["away", "for", "per", "at", "on", "to", "in", "into"]) {
      expect(isAccepted(answer, per), answer).toBe(true);
    }
    expect(isAccepted("under", per)).toBe(false);
  });

  it("accepts with or without the English infinitive marker", () => {
    expect(isAccepted("run", word(["to run"]))).toBe(true);
    expect(isAccepted("to run", word(["run"]))).toBe(true);
  });

  it("accepts with or without an article, in both base languages", () => {
    expect(isAccepted("house", word(["the house"]))).toBe(true);
    expect(isAccepted("das Haus", word(["Haus"]))).toBe(true);
    expect(isAccepted("Haus", word(["das Haus"]))).toBe(true);
  });

  it("strips a parenthetical qualifier", () => {
    expect(isAccepted("firm", word(["(a) firm"]))).toBe(true);
    expect(isAccepted("bank", word(["bank (financial)"]))).toBe(true);
  });

  it("splits on slashes, semicolons and 'or'", () => {
    expect(isAccepted("wood", word(["wood/forest"]))).toBe(true);
    expect(isAccepted("forest", word(["wood/forest"]))).toBe(true);
    expect(isAccepted("lift", word(["lift; elevator"]))).toBe(true);
    expect(isAccepted("elevator", word(["lift or elevator"]))).toBe(true);
  });

  it("accepts the primary sense as well as the list", () => {
    expect(isAccepted("juice", word(["extract", "sap"], "juice"))).toBe(true);
  });
});

describe("the prefix rule — for the ~5% of cards that kept Wiktionary phrasing", () => {
  /**
   * These two are live rows, named in ISSUES.md. Exact match calls "juice"
   * wrong for `succo`, which is the expensive error: it sends a card the
   * learner knew to `Again` and teaches them that the app is unreliable.
   */
  it("accepts the leading sense of a long definition", () => {
    const succo = word(["juice"], "juice except tomato juice");
    expect(isAccepted("juice", succo)).toBe(true);

    const svolazzare = word([], "to fly here and there without precise direction");
    expect(isAccepted("to fly", svolazzare)).toBe(true);
    expect(isAccepted("fly", svolazzare)).toBe(true);
  });

  it("does not accept a word from the middle of the definition", () => {
    // A prefix, not containment. This is the whole reason for the restriction.
    const succo = word([], "juice except tomato juice");
    expect(isAccepted("tomato", succo)).toBe(false);
    expect(isAccepted("except", succo)).toBe(false);
  });

  it("does not accept a partial word", () => {
    const succo = word([], "juice except tomato juice");
    expect(isAccepted("jui", succo)).toBe(false);
    expect(isAccepted("juic", succo)).toBe(false);
  });

  it("does not apply the prefix rule to short clean senses", () => {
    // "fir" must not answer "firm". The translations list is a shortlist of
    // clean senses where a prefix would be pure over-acceptance.
    expect(isAccepted("fir", word(["firm"]))).toBe(false);
    expect(isAccepted("hous", word(["house"]))).toBe(false);
  });

  it("does not apply the prefix rule to a single-word primary sense", () => {
    expect(isAccepted("hou", word([], "house"))).toBe(false);
  });

  it("needs at least the minimum prefix length", () => {
    expect(MIN_PREFIX).toBe(3);
    // "to" alone prefixes half the verb definitions in the deck.
    expect(isAccepted("to", word([], "to fly here and there"))).toBe(false);
  });
});

describe("what the learner is shown", () => {
  it("shows the primary sense as the expected answer", () => {
    expect(expectedAnswer(word(["extract"], "juice"))).toBe("juice");
  });

  it("falls back to the first translation when there is no primary sense", () => {
    // The fallback exercised with the primary absent: stage 5 chose a sense
    // for every live row, but a card with none must still be answerable rather
    // than showing an empty string where the answer should be.
    expect(expectedAnswer(word(["extract", "sap"], null))).toBe("extract");
  });

  it("shows an empty string rather than crashing on a word with nothing", () => {
    expect(expectedAnswer(word([], null))).toBe("");
    expect(hintFor(word([], null))).toBe("");
  });

  it("the hint gives the first letter of each word and nothing more", () => {
    expect(hintFor(word([], "the house"))).toBe("t·· h····");
    expect(hintFor(word(["juice"]))).toBe("j····");
  });
});

describe("the accepted set", () => {
  it("contains no empty strings", () => {
    const forms = acceptedForms(word(["away, for, ", "(x)"], "to fly, here"));
    expect(forms).not.toContain("");
    expect(forms.length).toBeGreaterThan(0);
  });

  it("is derived from both the list and the primary sense", () => {
    const forms = acceptedForms(word(["sap"], "juice"));
    expect(forms).toContain("sap");
    expect(forms).toContain("juice");
  });
});
