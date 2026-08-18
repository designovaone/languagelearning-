"""
Assessment material: generated pseudowords (PLAN.md §6, M3).

**Not deck content.** This sits in the pipeline because it has the same shape as
every other stage -- offline, deterministic, writes a checked-in artifact, never
runs in production -- but nothing here ends up on a flashcard. It is numbered
outside the 1-9 content sequence for that reason.

### Why generate rather than borrow

LexTALE and LexITA publish their item lists. A published list can be taken
exactly once before it is memorised, which makes it useless for the
re-assessment every ~3 months that turns onboarding into a progress measure
(PLAN.md §6, Part D). So the pool is generated, and each sitting draws from it.

### How

A character **trigram model** over real words of the language, the approach
behind Wuggy. Two padding symbols at the start, one at the end, so the model
learns how words are allowed to begin and end rather than only how they
continue. Trained on word *types*, not tokens: weighting by frequency would
teach it to produce `di`, `il` and `che` rather than the shape of the
vocabulary at large.

### The one thing that must not happen

**A real word must never enter the pool.** A learner who says "I know this"
about a real word that we are counting as a trap gets penalised for being
right, and the correction formula silently inverts. So every candidate is
checked against every real form available -- both frequency corpora in full
(~1.1M surface forms for Italian) plus the curated lists and their translations.

That is a *stronger* filter than the lemma list PLAN.md §6 specifies, and
deliberately so: a pseudoword must not collide with any real form, inflected
ones included. `andavamo` is not a lemma and is very much a real word.

Input : pipeline/raw/{it,en}_full.txt, {it,en}wiki-frequency.tsv.xz,
        pipeline/raw/{it,en}-wordlist.txt
        pipeline/artifacts/{it,en}-01-words.jsonl, {it,en}-01b-freq.jsonl
Output: pipeline/artifacts/{it,en}-20-pseudowords.jsonl
"""

import json
import lzma
import random
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

from _sources import write_manifest

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "pipeline" / "raw"
OUT = ROOT / "pipeline" / "artifacts"

START, END = "\x02", "\x03"

LANGUAGES = {
    "it": {
        "subs": "it_full.txt",
        "wiki": "itwiki-frequency.tsv.xz",
        "words": "it-01-words.jsonl",
        "freq": "it-01b-freq.jsonl",
        "out": "it-20-pseudowords.jsonl",
        "wordlist": "it-wordlist.txt",
        "alphabet": "abcdefghilmnopqrstuvzàèéìòù",
    },
    "en": {
        "subs": "en_full.txt",
        "wiki": "enwiki-frequency.tsv.xz",
        "words": "en-01-words.jsonl",
        "freq": "en-01b-freq.jsonl",
        "out": "en-20-pseudowords.jsonl",
        "wordlist": "en-wordlist.txt",
        "alphabet": "abcdefghijklmnopqrstuvwxyz",
    },
}

#: How many to aim for per language. The length quotas below are rounded per
#: bucket, so the pool lands near this rather than exactly on it.
TARGET = 1200

#: The floor that actually matters: PLAN.md §6 wants 1,000 candidates checked,
#: and a pool this size lets Part D draw fresh items for years.
MIN_POOL = 1000

#: Trained on the most frequent real words, so the model learns the shape of
#: ordinary vocabulary rather than of the long tail of rare compounds.
TRAIN_TOP = 30_000

MIN_LEN, MAX_LEN = 4, 11
MAX_ATTEMPTS = 400_000

#: Seeded, so re-running produces the same pool and the artifact does not churn.
SEED = 20260818


def norm(text: str) -> str:
    return unicodedata.normalize("NFKC", text).strip().lower()


def read_subs(path: Path) -> set[str]:
    words = set()
    for line in path.open(encoding="utf-8"):
        parts = line.split()
        if len(parts) == 2:
            words.add(norm(parts[0]))
    return words


def read_wiki(path: Path) -> set[str]:
    words = set()
    with lzma.open(path, "rt", encoding="utf-8") as fh:
        next(fh, "")
        for line in fh:
            head = line.split("\t", 1)[0]
            if head:
                words.add(norm(head))
    return words


def read_jsonl_field(path: Path, field: str) -> list[str]:
    out = []
    for line in path.open(encoding="utf-8"):
        if line.strip():
            row = json.loads(line)
            value = row.get(field)
            if isinstance(value, str):
                out.append(norm(value))
    return out


def train(words: list[str]) -> dict[tuple[str, str], Counter]:
    """Trigram counts: (previous two characters) -> next character."""
    model: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for word in words:
        padded = START + START + word + END
        for i in range(2, len(padded)):
            model[(padded[i - 2], padded[i - 1])][padded[i]] += 1
    return model


def generate(model: dict[tuple[str, str], Counter], rng: random.Random) -> str | None:
    """Sample until the model emits its own end marker.

    Length is *not* steered. An earlier version drew a target length and
    suppressed END until it was reached, which pushed the Italian mean from 7.7
    to 10.0 — the trigram model already encodes how long words are, because it
    was trained with the end marker in place, and overriding that only
    distorted it. The length guard below is what caught this.
    """
    out: list[str] = []
    context = (START, START)
    while len(out) < MAX_LEN:
        choices = model.get(context)
        if not choices:
            return None
        char = rng.choices(list(choices), weights=list(choices.values()), k=1)[0]
        if char == END:
            break
        out.append(char)
        context = (context[1], char)
    return "".join(out)


def plausible(word: str, alphabet: set[str], vowels: set[str]) -> bool:
    if not MIN_LEN <= len(word) <= MAX_LEN:
        return False
    if not set(word) <= alphabet:
        return False
    if not set(word) & vowels:
        return False
    # Three identical letters in a row occurs in no ordinary word and reads as
    # a typo rather than as a word the learner simply does not know.
    return not any(word[i] == word[i + 1] == word[i + 2] for i in range(len(word) - 2))


def run(lang: str, spec: dict) -> int:
    paths = {
        "subs": RAW / spec["subs"],
        "wiki": RAW / spec["wiki"],
        "wordlist": RAW / spec["wordlist"],
        "words": OUT / spec["words"],
        "freq": OUT / spec["freq"],
    }
    for name, path in paths.items():
        if not path.exists():
            print(f"missing input ({name}): {path}", file=sys.stderr)
            return 2

    # Every real form we can lay hands on. This set is the whole safety story.
    real: set[str] = read_subs(paths["subs"]) | read_wiki(paths["wiki"])
    real |= set(read_jsonl_field(paths["words"], "lemma"))
    real |= set(read_jsonl_field(paths["freq"], "lemma"))
    # A dictionary word list as well as the corpora. Checked against a system
    # dictionary, the corpora alone leaked `accurse`, `flanch` and `revender`
    # into the English pool -- genuine but archaic words that appear in neither
    # film subtitles nor Wikipedia. Corpus absence is not evidence a word does
    # not exist, and a real word among the traps penalises a learner for being
    # right.
    # Every configured language's word list, not just this one, because the
    # learner knows more than one language. An English word offered as an
    # Italian trap is not a trap: the Italian course is taught from English, so
    # `unco` and `imino` -- which the corpora and the Italian list both cleared
    # -- would be recognised on sight. The false-alarm rate is meant to measure
    # over-claiming, not vocabulary the learner legitimately has.
    #
    # This loop covers `spec["wordlist"]` as well; listing that separately
    # first was redundant, and the redundancy made an aliveness check pass
    # while the filter it was meant to disable stayed fully in place.
    for other in LANGUAGES.values():
        path = RAW / other["wordlist"]
        if not path.exists():
            print(f"missing input (wordlist): {path}", file=sys.stderr)
            return 2
        real |= {norm(line) for line in path.open(encoding="utf-8", errors="ignore")}
    real.discard("")

    ranked = read_jsonl_field(paths["freq"], "lemma")
    alphabet = set(spec["alphabet"])
    vowels = set("aeiouàèéìòù") & alphabet

    training = [w for w in ranked[:TRAIN_TOP] if plausible(w, alphabet, vowels)]
    if len(training) < 2000:
        print(f"FAIL [{lang}]: only {len(training)} training words", file=sys.stderr)
        return 1
    lengths = [len(w) for w in training]
    model = train(training)

    # Fill length buckets in the proportions real words have.
    #
    # A trigram model has no global length control: each step carries a small,
    # roughly constant chance of ending, so lengths come out close to geometric
    # with a fatter tail than real vocabulary. Left alone the Italian pool
    # averaged 9.0 characters against 7.7 for real words, which would make the
    # traps identifiable by shape alone — a learner could score well by
    # rejecting anything long, and the false-alarm correction would measure
    # nothing.
    #
    # This filters finished words rather than steering the sampler, so the
    # phonotactics stay exactly as the model produced them.
    histogram = Counter(lengths)
    quota: dict[int, int] = {}
    for length, count in histogram.items():
        quota[length] = round(TARGET * count / len(lengths))
    filled: Counter[int] = Counter()

    rng = random.Random(SEED)
    pool: dict[str, None] = {}
    attempts = 0
    wanted = sum(quota.values())
    while len(pool) < wanted and attempts < MAX_ATTEMPTS:
        attempts += 1
        candidate = generate(model, rng)
        if not candidate or candidate in pool:
            continue
        if not plausible(candidate, alphabet, vowels):
            continue
        if candidate in real:
            continue
        size = len(candidate)
        if filled[size] >= quota.get(size, 0):
            continue
        filled[size] += 1
        pool[candidate] = None

    words = sorted(pool)

    # ---- guards -----------------------------------------------------------
    problems = []
    if len(words) < MIN_POOL:
        problems.append(f"generated {len(words)}, below the {MIN_POOL} floor, after {attempts} attempts")

    # PLAN.md §6 exit criterion, restated as an assertion over the output.
    leaked = [w for w in words if w in real]
    if leaked:
        problems.append(f"{len(leaked)} real words in the pool: {leaked[:5]}")

    # Prove the filter is alive. If `real` failed to load, the check above
    # passes for the worst possible reason -- nothing to compare against.
    canaries = [w for w in ranked[:200] if plausible(w, alphabet, vowels)][:50]
    if len(canaries) < 20:
        problems.append("too few canaries to prove the real-word filter works")
    missed = [w for w in canaries if w not in real]
    if missed:
        problems.append(f"real-word filter does not recognise: {missed[:5]}")

    # An independent Gegenprobe: a dictionary that was never part of the filter.
    # This is the check that found `accurse`, `flanch` and `revender` in the
    # English pool and `unco` and `imino` in the Italian one, when the corpora
    # alone had passed everything. A filter cannot audit itself -- it will
    # always report clean on exactly the words it does not know.
    system_dict = Path("/usr/share/dict/words")
    if system_dict.exists():
        known = {norm(line) for line in system_dict.open(encoding="utf-8", errors="ignore")}
        escaped = sorted(w for w in words if w in known)
        if escaped:
            problems.append(f"{len(escaped)} real words the filter missed: {escaped[:8]}")
    else:
        print(f"  note [{lang}]: no /usr/share/dict/words, independent check skipped")

    real_mean = sum(lengths) / len(lengths)
    pool_mean = sum(len(w) for w in words) / len(words) if words else 0
    if abs(real_mean - pool_mean) > 1.5:
        problems.append(
            f"length drift: real mean {real_mean:.1f}, pool mean {pool_mean:.1f}"
        )

    if problems:
        for problem in problems:
            print(f"FAIL [{lang}]: {problem}", file=sys.stderr)
        return 1

    out_path = OUT / spec["out"]
    with out_path.open("w", encoding="utf-8") as fh:
        for word in words:
            fh.write(json.dumps({"form": word, "length": len(word)}, ensure_ascii=False) + "\n")

    print(f"{lang}: {len(words)} pseudowords -> {out_path.relative_to(ROOT)}")
    print(f"    checked against {len(real):,} real forms; {attempts:,} attempts")
    print(f"    mean length {pool_mean:.1f} (real {real_mean:.1f})")
    print(f"    sample: {', '.join(words[:14])}")
    return 0


def main() -> int:
    for lang, spec in LANGUAGES.items():
        code = run(lang, spec)
        if code:
            return code
    manifest = write_manifest({"english-words", "paroleitaliane"})
    print(f"attribution -> {manifest.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
