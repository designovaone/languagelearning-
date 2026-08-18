"""
Stage 5: pick the one primary sense.

Stage 4 leaves a *ranked shortlist*, not a decision. Position 1 is usually
right -- `casa` -> house, `dog` -> Hund -- but the deck shows one answer on a
card, and "usually right" is not a card.

### The two languages need different work, which PLAN.md §5 did not anticipate

Measured on the real artifacts:

| | needs a choice (>1 option) | needs a cleanup (first is a gloss) |
|---|---|---|
| Italian -> English | 68.8% | **56.3%** |
| English -> German | 79.4% | 0.2% |

The English Wiktionary's *German translations* are clean words (`Betrug`,
`Täuschung`). Its *English glosses of Italian words* are definitions:
`crescere` -> "to grow, to increase, to expand", `atmosfera` -> "atmosphere
(all meanings), air", `praghese` -> "of or relating to Prague or the Prague
people". Choosing between definitions still leaves a definition on the card.

So this stage does two jobs, and does the cheap one first:

1. **`simplify()` -- deterministic, free, no API.** Drop parentheticals, take
   the first comma- or semicolon-separated equivalent, tidy whitespace. That
   alone turns "atmosphere (all meanings), air" into "atmosphere". It runs on
   every candidate before the model ever sees it, which shortens the prompt and
   means a missing API key still leaves the deck better than it found it.
2. **The model picks between the surviving candidates.** Only where a genuine
   choice remains.

### This stage costs money, so it may never repeat work

`{lang}-05-primary.jsonl` is both the output and the cache, and it is checked
in (PLAN.md §5: "a re-run never repeats a paid step"). A row records the
`options` it was decided from, so an upstream change to stage 4 re-opens that
one row and nothing else. Interrupt it at any point and the next run resumes.

### The model may choose, but it may not invent

Every answer is checked back against the candidate list. Anything that is not
one of the offered candidates is discarded and the row falls back to
`simplify(options[0])`, counted and reported. A translation engine that quietly
invents a plausible word is the worst possible failure here, because the output
looks exactly like success.

Input : pipeline/artifacts/{it,en}-04-translations.jsonl
Output: pipeline/artifacts/{it,en}-05-primary.jsonl
Usage :
    export OPENROUTER_API_KEY=...
    python3 05_primary_sense.py --dry-run          # free, deterministic only
    python3 05_primary_sense.py --lang it --limit 50
    python3 05_primary_sense.py                    # the full pass
    python3 05_primary_sense.py --sample 50        # for the hand-check
"""

import argparse
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from _sources import write_manifest

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "pipeline" / "artifacts"

API_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "google/gemini-2.5-flash-lite"

LANGUAGES = {
    "it": {
        "source": "it-04-translations.jsonl",
        "out": "it-05-primary.jsonl",
        "target": "Italian",
        "base": "English",
        "source_id": "wiktextract-it",
        # Words whose primary sense is not debatable. If the pass cannot get
        # these right, the prompt or the model is wrong, and every other answer
        # is suspect -- but no other check would notice, because a wrong
        # translation looks exactly like a right one.
        "canaries": {
            "casa": "house",
            "acqua": "water",
            "cane": "dog",
            "libro": "book",
            "mangiare": "eat",
        },
    },
    "en": {
        "source": "en-04-translations.jsonl",
        "out": "en-05-primary.jsonl",
        "target": "English",
        "base": "German",
        "source_id": "wiktextract-en",
        "canaries": {
            "dog": "Hund",
            "water": "Wasser",
            "house": "Haus",
            "book": "Buch",
            "eat": "essen",
        },
    },
}

BATCH = 40
MAX_RETRIES = 4
#: Above this share of rows falling back, the model is not doing its job.
MAX_FALLBACK = 0.10

#: Wiktionary separates alternative equivalents with these.
SPLIT = re.compile(r"\s*[;,]\s*")

#: Words that cannot stand alone as a translation. Used only to detect a comma
#: that falls *inside* a phrase -- see `simplify`.
FRAGMENTS = frozenset(
    "a an the of from to in on at with by for as or and that which used not".split()
)


def strip_asides(text: str) -> str:
    """Remove parenthesised asides, counting depth.

    A regex cannot do this. `[^)]*` on "to water (to provide (animals) with
    water)" matches from the first `(` to the *first* `)`, leaving the trailing
    " with water)" behind -- which is how `abbeverare` became
    "to water with water)".
    """
    out: list[str] = []
    depth = 0
    for char in text:
        if char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(char)
    return "".join(out)


def tidy(text: str) -> str:
    return " ".join(text.split()).strip(" .:;,-")


def simplify(text: str) -> str:
    """One equivalent, no asides. Deterministic, and applied before the model.

    "to grow, to increase, to expand"  -> "to grow"
    "atmosphere (all meanings), air"   -> "atmosphere"
    "(paint-) Pinsel"                  -> "Pinsel"
    "to water (to provide (animals) with water)" -> "to water"

    A comma usually separates alternatives, but not always: in "of, from or
    relating to Abruzzo" it sits inside a single phrase, and splitting on it
    yields "of". So a leading segment made only of function words is treated as
    a phrase that was cut in half, and the whole string is kept instead.

    That test requires a *following* segment, which is what keeps it safe for
    German: `hardship` -> "Not" and `in` -> "in" are correct one-word answers
    that happen to collide with English function words.
    """
    without_asides = strip_asides(text)
    parts = SPLIT.split(without_asides.strip())
    first = tidy(parts[0])
    if len(parts) > 1 and (
        not first or all(word.lower() in FRAGMENTS for word in first.split())
    ):
        return tidy(without_asides)
    return first


def candidates(translations: list[str]) -> list[str]:
    """Simplified, de-duplicated, order preserved. Empty results dropped."""
    seen: dict[str, None] = {}
    for raw in translations:
        value = simplify(raw)
        if value:
            seen.setdefault(value, None)
    return list(seen)


def normalise(text: str) -> str:
    return " ".join(text.lower().split()).strip(" .:;,-")


PROMPT = """You are building a vocabulary flashcard deck.

For each numbered item you get a {target} headword and a list of candidate \
{base} translations taken from Wiktionary. Choose the ONE candidate a learner \
should see on the back of the card: the most common, most neutral everyday \
meaning of the headword.

Rules:
- Answer with one of the candidates EXACTLY as written. Do not reword, \
translate, expand, or invent.
- Prefer the ordinary everyday sense over a technical, regional, archaic, \
vulgar or figurative one.
- If several candidates mean the same thing, pick the most common single word.

Return ONLY a JSON object mapping each item number to your chosen string, \
like {{"1": "house", "2": "water"}}. No prose, no code fence.

Items:
{items}"""


def build_prompt(spec: dict, batch: list[dict]) -> str:
    lines = []
    for i, row in enumerate(batch, 1):
        pos = "/".join(row.get("pos") or [])
        head = f"{row['lemma']}" + (f" ({pos})" if pos else "")
        options = " | ".join(row["_candidates"])
        lines.append(f"{i}. {head}: {options}")
    return PROMPT.format(target=spec["target"], base=spec["base"], items="\n".join(lines))


def call_model(prompt: str, model: str, api_key: str) -> str:
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }
    ).encode()
    request = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                payload = json.load(response)
            return payload["choices"][0]["message"]["content"]
        except (urllib.error.HTTPError, urllib.error.URLError, KeyError, TimeoutError) as error:
            last_error = error
            # Rate limits and 5xx are the normal case here, not the exception.
            time.sleep(2**attempt)
    raise RuntimeError(f"model call failed after {MAX_RETRIES} attempts: {last_error}")


def parse_answer(text: str) -> dict[str, str]:
    """Tolerate a code fence; refuse anything else."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-z]*\n?|\n?```$", "", cleaned)
    parsed = json.loads(cleaned)
    if not isinstance(parsed, dict):
        raise ValueError("expected a JSON object")
    return {str(k): str(v) for k, v in parsed.items()}


def decide(row: dict, answer: str | None) -> tuple[str, str]:
    """Return (primary_sense, how). The model may choose or extract, never invent.

    Two forms of answer are accepted:

    - **`model`** -- the answer is one of the candidates.
    - **`extract`** -- the answer appears *inside* a candidate, on whole-word
      boundaries. Wiktionary buries the real translation inside a definition
      often enough that rejecting this is worse than allowing it: `cigno` is
      offered "any member of the Cygnus taxonomic genus – swan", and the answer
      wanted on the card is "swan". Requiring an exact match turned every one
      of those into a fallback and put the whole definition on the card.

    Anything else is refused. Both forms keep the guarantee that matters: every
    word on the card came from the source text, so the model cannot quietly
    substitute a plausible translation of its own.
    """
    options = row["_candidates"]
    if len(options) == 1:
        return options[0], "single"
    if answer:
        wanted = normalise(answer)
        for option in options:
            if normalise(option) == wanted:
                return option, "model"
        # Whole-word, so "hair" does not match "chair" and "ear" does not
        # match "year".
        if len(wanted) > 1:
            pattern = re.compile(rf"(?<!\w){re.escape(wanted)}(?!\w)")
            for option in options:
                if pattern.search(normalise(option)):
                    return tidy(answer), "extract"
    return options[0], "fallback"


def load_cache(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    cache = {}
    for line in path.open(encoding="utf-8"):
        if line.strip():
            row = json.loads(line)
            cache[row["lemma"]] = row
    return cache


def write_rows(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as fh:
        for row in sorted(rows, key=lambda r: r["lemma"]):
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def run(lang: str, spec: dict, args: argparse.Namespace, api_key: str | None) -> int:
    source = OUT / spec["source"]
    if not source.exists():
        print(f"missing input: {source}", file=sys.stderr)
        return 2
    out_path = OUT / spec["out"]

    rows = []
    for line in source.open(encoding="utf-8"):
        if not line.strip():
            continue
        row = json.loads(line)
        row["_candidates"] = candidates(row.get("translations") or [])
        if row["_candidates"]:
            rows.append(row)
    if args.limit:
        rows = rows[: args.limit]

    cache = load_cache(out_path)
    decided: dict[str, dict] = {}
    pending: list[dict] = []

    for row in rows:
        cached = cache.get(row["lemma"])
        # Re-open a row if the candidate list changed upstream, OR if it was
        # only ever settled by falling back. A fallback is not a decision --
        # it is what happens when no decision was made, and a --dry-run
        # produces nothing else. Treating one as settled would let a free run
        # silently cancel the paid one.
        stale = (
            not cached
            or cached.get("options") != row["_candidates"]
            or cached.get("decided_by") == "fallback"
        )
        if not stale:
            decided[row["lemma"]] = cached
        elif len(row["_candidates"]) == 1:
            sense, how = decide(row, None)
            decided[row["lemma"]] = {
                "lemma": row["lemma"],
                "primary_sense": sense,
                "decided_by": how,
                "options": row["_candidates"],
                "source_id": spec["source_id"],
            }
        else:
            pending.append(row)

    print(f"{lang}: {len(rows)} rows | {len(decided)} already settled | {len(pending)} need the model")

    if pending and not args.dry_run:
        if not api_key:
            print(
                "OPENROUTER_API_KEY is not set. Run with --dry-run for the free "
                "deterministic pass, or export a key for the full one.",
                file=sys.stderr,
            )
            return 2
        for start in range(0, len(pending), BATCH):
            batch = pending[start : start + BATCH]
            try:
                answers = parse_answer(call_model(build_prompt(spec, batch), args.model, api_key))
            except (RuntimeError, ValueError, json.JSONDecodeError) as error:
                # A dead batch must not lose the batches already paid for.
                print(f"  batch at {start} failed ({error}); falling back", file=sys.stderr)
                answers = {}
            for i, row in enumerate(batch, 1):
                sense, how = decide(row, answers.get(str(i)))
                decided[row["lemma"]] = {
                    "lemma": row["lemma"],
                    "primary_sense": sense,
                    "decided_by": how,
                    "options": row["_candidates"],
                    "model": args.model,
                    "source_id": spec["source_id"],
                }
            # Checkpoint after every batch, so an interrupt costs one batch.
            write_rows(out_path, list({**cache, **decided}.values()))
            print(f"  {min(start + BATCH, len(pending))}/{len(pending)}", end="\r", flush=True)
        print()
    elif pending:
        for row in pending:
            sense, how = decide(row, None)
            decided[row["lemma"]] = {
                "lemma": row["lemma"],
                "primary_sense": sense,
                "decided_by": how,
                "options": row["_candidates"],
                "source_id": spec["source_id"],
            }

    final = {**cache, **decided}
    kept = [final[row["lemma"]] for row in rows if row["lemma"] in final]

    counts = {"model": 0, "extract": 0, "single": 0, "fallback": 0}
    for row in kept:
        counts[row["decided_by"]] = counts.get(row["decided_by"], 0) + 1
    chosen = counts["model"] + counts["extract"] + counts["fallback"]
    fallback_rate = counts["fallback"] / chosen if chosen else 0.0

    problems = []
    if len(kept) != len(rows):
        problems.append(f"{len(rows) - len(kept)} rows ended with no primary sense")
    if any(not r["primary_sense"].strip() for r in kept):
        problems.append("some rows have an empty primary sense")
    if not args.dry_run and fallback_rate > MAX_FALLBACK:
        problems.append(f"{fallback_rate:.1%} of choices fell back, over the {MAX_FALLBACK:.0%} limit")
    if not args.dry_run and not args.limit:
        by_lemma = {r["lemma"]: r["primary_sense"] for r in kept}
        for lemma, expected in spec["canaries"].items():
            got = by_lemma.get(lemma)
            if got and normalise(expected) not in normalise(got):
                problems.append(f"canary {lemma!r} -> {got!r}, expected {expected!r}")

    if problems:
        for problem in problems:
            print(f"FAIL [{lang}]: {problem}", file=sys.stderr)
        return 1

    if args.dry_run:
        # A dry run reports; it never writes. Its answers are all fallbacks,
        # and an artifact full of fallbacks is worse than no artifact because
        # it looks finished.
        print(f"    (dry run — {out_path.name} not written)")
    else:
        write_rows(out_path, list(final.values()))
        print(f"    -> {out_path.relative_to(ROOT)}  ({len(kept)} rows)")
    print(
        f"    single {counts['single']}  model {counts['model']}  "
        f"extract {counts['extract']}  fallback {counts['fallback']}"
    )

    if args.sample:
        random.seed(args.seed)
        print(f"\n    --- {args.sample} random rows for the hand-check (PLAN.md §5) ---")
        for row in random.sample(kept, min(args.sample, len(kept))):
            others = [o for o in row["options"] if o != row["primary_sense"]]
            tail = f"   (over: {', '.join(others[:3])})" if others else ""
            print(f"    {row['lemma']:<20} -> {row['primary_sense']}{tail}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage 5: pick the primary sense.")
    parser.add_argument("--lang", choices=sorted(LANGUAGES), help="default: both")
    parser.add_argument("--limit", type=int, default=0, help="first N rows only")
    parser.add_argument("--sample", type=int, default=0, help="print N random results")
    parser.add_argument("--seed", type=int, default=1, help="sample seed")
    parser.add_argument("--model", default=os.environ.get("OPENROUTER_MODEL_PIPELINE", DEFAULT_MODEL))
    parser.add_argument("--dry-run", action="store_true", help="deterministic only, no API calls")
    args = parser.parse_args()

    api_key = os.environ.get("OPENROUTER_API_KEY") or None
    langs = [args.lang] if args.lang else sorted(LANGUAGES)

    used: set[str] = set()
    for lang in langs:
        code = run(lang, LANGUAGES[lang], args, api_key)
        if code:
            return code
        used.add(LANGUAGES[lang]["source_id"])

    manifest = write_manifest(used)
    print(f"attribution -> {manifest.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
