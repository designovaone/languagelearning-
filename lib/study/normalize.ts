/**
 * Deciding whether a typed answer is right (PLAN.md §7.3).
 *
 * This runs on the device, before any network call, because the whole feel of
 * the drill depends on the verdict appearing the instant the learner presses
 * enter. The server never re-grades correctness — it stores `answer_given`
 * alongside `was_correct`, so a disagreement is always recoverable from the
 * log.
 *
 * ### The asymmetry that shapes every rule here
 *
 * Marking a right answer wrong is the expensive error. It sends a card the
 * learner actually knew to `Again`, and — worse — it is the failure that makes
 * someone stop trusting the app on day one. Marking a wrong answer right costs
 * one delayed correction. So the rules below are deliberately generous, and
 * every one of them exists because of a card that is really in the deck.
 */

/**
 * Words that carry no meaning on their own and must never decide a verdict.
 * Base languages are English and German; `to` covers the English infinitive
 * marker, which appears on roughly every verb translation in the deck.
 */
const LEADING_NOISE = new Set([
  "to", "the", "a", "an",
  "der", "die", "das", "den", "dem", "des",
  "ein", "eine", "einen", "einem", "einer", "eines",
  "zu", "sich",
]);

/**
 * Casing, accents, punctuation and surrounding space all removed.
 *
 * Accents go because the base-language answer is typed on a phone keyboard the
 * learner has not switched: someone answering "café" as "cafe" has not made a
 * vocabulary mistake.
 */
export function normalize(input: string): string {
  return input
    // ß folds to ss before anything else. Both are correct German spellings of
    // the same word, and `en-from-de` learners type their answers in German on
    // a phone where ß is a long-press away. NFD does not decompose it, so it
    // has to be done by hand.
    //
    // Deliberately *not* done: folding ue/oe/ae to u/o/a. That would turn
    // "Steuer" into "Stuer" and break more than it fixes, and a German
    // keyboard has the umlauts on it anyway.
    .replace(/ß/g, "ss")
    .replace(/ẞ/g, "ss")
    .normalize("NFD")
    // Combining marks. Everything that survives NFD as a separate code point.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalized, with a leading article or infinitive marker dropped. */
function stripLeading(normalized: string): string {
  const words = normalized.split(" ");
  while (words.length > 1 && LEADING_NOISE.has(words[0])) words.shift();
  return words.join(" ");
}

/**
 * Every form of one stored sense that counts as correct.
 *
 * A stored translation is often a list, not a word: `away, for, per, at, on,
 * to, in, into` is a single `translations` entry in the live deck. Splitting on
 * separators is what makes each of those an answer instead of requiring the
 * learner to reproduce the punctuation.
 */
function formsOf(sense: string): string[] {
  const forms = new Set<string>();
  const add = (value: string) => {
    const normalized = normalize(value);
    if (!normalized) return;
    forms.add(normalized);
    forms.add(stripLeading(normalized));
  };

  add(sense);
  // Parentheticals are qualifiers, not part of the answer: "(a) firm".
  add(sense.replace(/\([^)]*\)/g, " "));
  for (const part of sense.split(/[,;/|]|\bor\b/)) add(part);

  return [...forms].filter(Boolean);
}

export type Answerable = {
  /** The stored list. Already a chosen shortlist by stage 4. */
  translations: string[];
  /** The one sense stage 5 picked. Shown as the expected answer. */
  primarySense: string | null;
};

/** Everything an exact match may be tested against. */
export function acceptedForms(word: Answerable): string[] {
  const forms = new Set<string>();
  for (const sense of word.translations) for (const form of formsOf(sense)) forms.add(form);
  if (word.primarySense) for (const form of formsOf(word.primarySense)) forms.add(form);
  return [...forms];
}

/**
 * The shortest answer a prefix match will accept.
 *
 * Three characters. Below that a prefix stops being evidence — "to" prefixes
 * half the verb definitions in the deck.
 */
export const MIN_PREFIX = 3;

/**
 * Whether `answer` is a whole-word prefix of `form`.
 *
 * This rule exists for a specific, measured defect. About 5% of the deck kept
 * Wiktionary's phrasing through stage 5: `succo` → "juice except tomato
 * juice", `svolazzare` → "to fly here and there without precise direction".
 * Typing "juice" is a correct answer to `succo` by any standard a human would
 * use, and exact match calls it wrong.
 *
 * Restricted to a *prefix* on a word boundary rather than containment. "juice"
 * matching "juice except tomato juice" is the intended case; "tomato" matching
 * it is not, and containment would accept both.
 */
function isWholeWordPrefix(answer: string, form: string): boolean {
  if (answer.length < MIN_PREFIX) return false;
  if (!form.startsWith(answer)) return false;
  return form.length === answer.length || form[answer.length] === " ";
}

/**
 * The verdict.
 *
 * Prefix matching is applied only to the **primary sense** and only when it is
 * a long phrase. The `translations` list is a shortlist of clean senses where a
 * prefix would be pure over-acceptance — "fir" should not answer "firm".
 */
export function isAccepted(answer: string, word: Answerable): boolean {
  const typed = normalize(answer);
  if (!typed) return false;

  const forms = acceptedForms(word);
  if (forms.includes(typed) || forms.includes(stripLeading(typed))) return true;

  const primary = word.primarySense ? normalize(word.primarySense) : "";
  if (!primary.includes(" ")) return false;

  for (const candidate of [typed, stripLeading(typed)]) {
    for (const form of [primary, stripLeading(primary)]) {
      if (isWholeWordPrefix(candidate, form)) return true;
    }
  }
  return false;
}

/** What the learner is shown after a wrong answer, or on "show answer". */
export function expectedAnswer(word: Answerable): string {
  return word.primarySense ?? word.translations[0] ?? "";
}

/**
 * The hint: first letter of the expected answer, rest masked.
 *
 * A hint is not free — it forces the grade to `Hard` (PLAN.md §7.3) — so it
 * has to be worth taking. One letter is enough to unlock a word on the tip of
 * the tongue and not enough to answer a word that was never known.
 */
export function hintFor(word: Answerable): string {
  const expected = expectedAnswer(word);
  return expected
    .split(" ")
    .map((part) => (part.length <= 1 ? part : part[0] + "·".repeat(part.length - 1)))
    .join(" ");
}
