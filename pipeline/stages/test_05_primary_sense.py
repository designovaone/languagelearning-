"""
Tests for stage 5's pure logic.

    cd pipeline/stages && python3 test_05_primary_sense.py

Deliberately stdlib-only and runnable on its own: the pipeline is a set of
one-off scripts run on a laptop, not part of the app's vitest suite, and adding
a Python test runner to this project to check two functions would cost more
than it earns.

What is worth testing here is narrow but load-bearing: `simplify` decides what
ends up on the back of a flashcard, and `decide` is the wall between "the model
chose" and "the model invented". The paid pass is not a good place to discover
either is wrong.
"""

import sys

from importlib.machinery import SourceFileLoader
from pathlib import Path

stage = SourceFileLoader(
    "stage05", str(Path(__file__).with_name("05_primary_sense.py"))
).load_module()

failures: list[str] = []


def check(name: str, got: object, want: object) -> None:
    if got != want:
        failures.append(f"{name}\n     got  {got!r}\n     want {want!r}")


# ---- simplify: one equivalent, no asides -----------------------------------

check("strips a trailing alternative",
      stage.simplify("to grow, to increase, to expand"), "to grow")
check("strips a parenthetical and the alternative after it",
      stage.simplify("atmosphere (all meanings), air"), "atmosphere")
check("strips a leading parenthetical",
      stage.simplify("(paint-) Pinsel"), "Pinsel")
check("strips a semicolon alternative",
      stage.simplify("The name of the letter A/a.; a"), "The name of the letter A/a")
check("leaves a clean word alone",
      stage.simplify("Hund"), "Hund")
check("leaves a real two-word answer alone",
      stage.simplify("to go to sleep"), "to go to sleep")
check("collapses whitespace",
      stage.simplify("  middle   classes "), "middle classes")
check("a parenthetical-only string simplifies to nothing",
      stage.simplify("(obsolete)"), "")

# Both of these shipped wrong in the first draft and were caught by reading the
# 50-word sample, not by any check. `abbeverare` came out as "to water with
# water)" and `abruzzese` as "of".
check("NESTED parens: a regex matches the inner close and leaks the tail",
      stage.simplify("to water (to provide (animals) with water)"), "to water")
check("nested parens, aside first",
      stage.simplify("(a (very) old form) Wasser"), "Wasser")
check("an unbalanced open paren does not eat the whole string silently",
      stage.simplify("Hund (male"), "Hund")
check("a comma INSIDE a phrase is not an alternative separator",
      stage.simplify("of, from or relating to Abruzzo or the Abruzzi"),
      "of, from or relating to Abruzzo or the Abruzzi")
check("...but a comma between real alternatives still splits",
      stage.simplify("to grow, to increase"), "to grow")
check("a one-word German answer that looks like an English stop word survives",
      stage.simplify("Not"), "Not")
check("...and so does a one-word answer identical to a stop word",
      stage.simplify("in"), "in")

# ---- candidates: simplified, de-duplicated, order kept ---------------------

check("de-duplicates after simplifying",
      stage.candidates(["to grow, to increase", "to grow", "to progress"]),
      ["to grow", "to progress"])
check("drops candidates that simplify to nothing",
      stage.candidates(["(archaic)", "Betrug"]), ["Betrug"])
check("keeps stage 4's ranking order",
      stage.candidates(["Hund", "Rüde", "Schabracke"]), ["Hund", "Rüde", "Schabracke"])

# ---- decide: the model may choose, never invent ----------------------------

one = {"_candidates": ["water"]}
check("a single candidate needs no model", stage.decide(one, None), ("water", "single"))
check("a single candidate ignores the model", stage.decide(one, "beer"), ("water", "single"))

many = {"_candidates": ["Hund", "Rüde", "Schabracke"]}
check("accepts a candidate the model picked",
      stage.decide(many, "Rüde"), ("Rüde", "model"))
check("accepts it despite case and spacing",
      stage.decide(many, "  rüde "), ("Rüde", "model"))
# Wiktionary buries the translation inside a definition often enough that an
# exact-match-only rule put "any member of the Cygnus taxonomic genus" on the
# swan card. Extraction is allowed; invention still is not.
gloss = {"_candidates": ["any member of the Cygnus taxonomic genus – swan", "the Cygnus constellation"]}
check("accepts a translation extracted from inside a gloss",
      stage.decide(gloss, "swan"), ("swan", "extract"))
check("extraction is whole-word: 'ear' must not match 'genus – swan'",
      stage.decide({"_candidates": ["a year of life", "other"]}, "ear"),
      ("a year of life", "fallback"))
check("a single character never counts as an extraction",
      stage.decide({"_candidates": ["Kreis", "rund"]}, "K"), ("Kreis", "fallback"))
check("an extracted answer keeps its own casing",
      stage.decide({"_candidates": ["einen Rabatt gewähren", "abtun"]}, "Rabatt"),
      ("Rabatt", "extract"))

check("REJECTS an invented answer and falls back to first",
      stage.decide(many, "Wolf"), ("Hund", "fallback"))
check("rejects a paraphrase whose words are not in any candidate",
      stage.decide(many, "male dog"), ("Hund", "fallback"))
check("rejects an empty answer",
      stage.decide(many, ""), ("Hund", "fallback"))
check("no answer at all falls back",
      stage.decide(many, None), ("Hund", "fallback"))

# ---- parse_answer: tolerate a fence, refuse anything else ------------------

check("plain JSON", stage.parse_answer('{"1": "house"}'), {"1": "house"})
check("fenced JSON", stage.parse_answer('```json\n{"1": "house"}\n```'), {"1": "house"})
check("coerces numeric values to strings", stage.parse_answer('{"1": 2}'), {"1": "2"})

# json.JSONDecodeError subclasses ValueError, as does the explicit raise for a
# non-object. Catching bare Exception here would make this pass for any reason
# at all, including an AttributeError from a refactor -- a check that reports
# success for the wrong reason, which is this project's recurring bug.
for bad in ('["house"]', "not json", ""):
    try:
        stage.parse_answer(bad)
        failures.append(f"parse_answer accepted {bad!r}, should have raised")
    except ValueError:
        pass

if failures:
    print(f"FAIL ({len(failures)}):", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    sys.exit(1)
print("stage 5 logic: all checks passed")
