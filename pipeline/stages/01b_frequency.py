"""
Stage 1b: frequency rank, blended from two corpora of opposite register.

Frequency is *not* the source of the deck -- the curated lists are (PLAN.md
§5). This stage decides the order *within* a band, so a first session is a run
of useful words rather than a run of words beginning with `a`.

Two corpora, deliberately chosen to disagree:

- **OpenSubtitles** (FrequencyWords) is film dialogue. It knows `ciao`, `beh`,
  `domani`, and has barely heard of `provincia`.
- **Wikipedia** (wikipedia-word-frequency-clean) is encyclopedic prose. It
  knows `provincia` and `febbraio`, and has barely heard of `ciao`.

Neither alone is what a learner needs. A learner needs both registers.

### Why the geometric mean and not the arithmetic one

PLAN.md §5 said "average the ranks". Measured on the real data, the plain
average is the wrong average, and the reason is structural rather than
cosmetic: rank distributions are heavy-tailed, so an arithmetic mean is
dominated by whichever corpus rates the word *worst*. A word that is essential
in one register and absent from the other gets buried.

Concretely, in the Italian Fondamentale band:

    ciao   subtitles #153  wikipedia #15068   geometric 683   arithmetic 1611
    ecco   subtitles #188  wikipedia #7251    geometric 535   arithmetic 1195
    bosco  subtitles #2719 wikipedia #3026    geometric 1143  arithmetic 986

The arithmetic mean teaches *bosco* ("woods") before *ciao*. The geometric
mean does not, because it rewards a word that is very common in **at least
one** register -- which is exactly the property a learner cares about. PLAN.md
§5 is amended to match.

### Missing from one corpus: use the other, no penalty

Checked rather than assumed. The words present in only one list fall into two
groups, and both argue against a penalty:

- **Tokenisation artifacts.** The Wikipedia list treats `-` and `'` as
  punctuation that cannot occur inside a word, so `e-mail`, `ping-pong`,
  `o'clock` and the English clitics `'s`/`'re` can never appear in it. These
  are common words, not rare ones; penalising them would be simply wrong.
- **Genuinely register-bound words**, e.g. `altoatesino` (wiki #59598) or
  `anticlimactically` (wiki #836584). These already carry a poor rank in the
  one corpus that has them, so the single rank is punishment enough.

So a word seen in one corpus is ranked by that corpus. No magic constant.

### Multi-word entries

CEFR-J lists ~150 phrases (`bus stop`, `air conditioning`). A single-token
corpus cannot rank them, so they take the rank of their **rarest component** --
a phrase cannot be more common than the least common word in it.

Input : pipeline/raw/{it,en}_full.txt, {it,en}wiki-frequency.tsv.xz
        pipeline/artifacts/{it,en}-01-words.jsonl   (which lemmas to rank)
Output: pipeline/artifacts/{it,en}-01b-freq.jsonl
"""

import json
import lzma
import math
import sys
import unicodedata
from collections import Counter
from pathlib import Path

from _sources import write_manifest

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "pipeline" / "raw"
OUT = ROOT / "pipeline" / "artifacts"

SUBS_SOURCE = "frequencywords"
WIKI_SOURCE = "wikiwordfreq"

LANGUAGES = {
    "it": {
        "subs": "it_full.txt",
        "wiki": "itwiki-frequency.tsv.xz",
        "words": "it-01-words.jsonl",
        "out": "it-01b-freq.jsonl",
        # Words no Italian learner list could sanely bury. If any of these
        # falls outside the head of the ranking, a corpus has been swapped or
        # a parse has broken -- which is the failure this stage cannot
        # otherwise notice, because a wrong ranking still looks like a ranking.
        "canaries": ["essere", "fare", "casa", "acqua", "bene", "ciao", "grazie"],
    },
    "en": {
        "subs": "en_full.txt",
        "wiki": "enwiki-frequency.tsv.xz",
        "words": "en-01-words.jsonl",
        "out": "en-01b-freq.jsonl",
        "canaries": ["the", "water", "house", "good", "time", "please", "day"],
    },
}

#: A canary must rank at least this well, out of a vocabulary of ~1M.
CANARY_MAX_RANK = 5_000

#: Below this share of curated lemmas carrying a rank, the blend has not done
#: its job and the artifact is not worth writing.
MIN_COVERAGE = 0.95

#: Below this share of ranks coming from *both* corpora, one of the two inputs
#: is effectively missing -- a blend of one is not a blend.
MIN_BLENDED = 0.90


def norm(text: str) -> str:
    """Match the Wikipedia list's own normalisation: NFKC, lowercase."""
    return unicodedata.normalize("NFKC", text).strip().lower()


def read_subs(path: Path) -> dict[str, int]:
    """FrequencyWords: `{word} {count}` per line."""
    counts: Counter[str] = Counter()
    for line in path.open(encoding="utf-8"):
        parts = line.split()
        if len(parts) != 2:
            continue
        word = norm(parts[0])
        if word:
            # Normalisation can collapse two source rows onto one word.
            counts[word] += int(parts[1])
    return dict(counts)


def read_wiki(path: Path) -> dict[str, int]:
    """wikipedia-word-frequency-clean: TSV, `word\tcount\tdocuments`."""
    counts: Counter[str] = Counter()
    with lzma.open(path, "rt", encoding="utf-8") as fh:
        header = next(fh, "")
        if not header.startswith("word\t"):
            raise ValueError(f"{path.name}: unexpected header {header!r}")
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            word = norm(parts[0])
            if word:
                counts[word] += int(parts[1])
    return dict(counts)


def to_ranks(counts: dict[str, int]) -> dict[str, int]:
    """Position in the frequency-sorted vocabulary, 1 = most frequent.

    Ties break alphabetically so the artifact is reproducible rather than
    dependent on dict ordering.
    """
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return {word: i + 1 for i, (word, _) in enumerate(ordered)}


def blend(subs: dict[str, int], wiki: dict[str, int]) -> dict[str, float]:
    """Geometric mean of the two ranks; the single rank where only one exists."""
    scores: dict[str, float] = {}
    for word in subs.keys() | wiki.keys():
        a, b = subs.get(word), wiki.get(word)
        if a and b:
            scores[word] = math.sqrt(a * b)
        else:
            scores[word] = float(a or b)  # type: ignore[arg-type]
    return scores


def read_lemmas(path: Path) -> list[str]:
    seen: dict[str, None] = {}
    for line in path.open(encoding="utf-8"):
        if line.strip():
            seen.setdefault(norm(json.loads(line)["lemma"]), None)
    return sorted(seen)


def components(lemma: str) -> list[str]:
    """Split a phrase into rankable parts. `-` and `'` stay inside the word."""
    return [p for p in lemma.split() if p]


def run(lang: str, spec: dict[str, object]) -> int:
    subs_path = RAW / str(spec["subs"])
    wiki_path = RAW / str(spec["wiki"])
    words_path = OUT / str(spec["words"])
    for path in (subs_path, wiki_path, words_path):
        if not path.exists():
            print(f"missing input: {path}", file=sys.stderr)
            return 2

    subs_rank = to_ranks(read_subs(subs_path))
    wiki_rank = to_ranks(read_wiki(wiki_path))
    scores = blend(subs_rank, wiki_rank)

    # One global ordering over everything either corpus has seen, so the rank
    # stored on a word means "how common is this word in the language", not
    # "where does it sit in our deck". The assessment needs the former.
    ordered = sorted(scores.items(), key=lambda kv: (kv[1], kv[0]))
    global_rank = {word: i + 1 for i, (word, _) in enumerate(ordered)}

    lemmas = read_lemmas(words_path)
    rows: list[dict[str, object]] = []
    basis_counts: Counter[str] = Counter()

    for lemma in lemmas:
        if lemma in global_rank:
            a, b = subs_rank.get(lemma), wiki_rank.get(lemma)
            basis = "blend" if a and b else ("subtitles" if a else "wikipedia")
            rank = global_rank[lemma]
        else:
            # A phrase is at most as common as its rarest component. Where even
            # that fails (a component unseen in either corpus) the lemma gets
            # no rank at all and sorts last within its band.
            parts = [global_rank[p] for p in components(lemma) if p in global_rank]
            if not parts or len(parts) != len(components(lemma)):
                basis_counts["unranked"] += 1
                continue
            a = b = None
            basis = "phrase"
            rank = max(parts)

        basis_counts[basis] += 1
        rows.append(
            {
                "lemma": lemma,
                "freq_rank": rank,
                "rank_subtitles": a,
                "rank_wikipedia": b,
                "basis": basis,
                "source_ids": [SUBS_SOURCE, WIKI_SOURCE],
            }
        )

    ranked = len(rows)
    coverage = ranked / len(lemmas)
    blended = basis_counts["blend"] / ranked if ranked else 0.0

    problems = []
    if coverage < MIN_COVERAGE:
        problems.append(f"only {coverage:.1%} of {len(lemmas)} lemmas ranked")
    if blended < MIN_BLENDED:
        problems.append(f"only {blended:.1%} of ranks used both corpora")
    for canary in spec["canaries"]:  # type: ignore[union-attr]
        rank = global_rank.get(norm(str(canary)))
        if rank is None or rank > CANARY_MAX_RANK:
            problems.append(f"canary {canary!r} ranked {rank}, expected <= {CANARY_MAX_RANK}")
    # Only the directly-ranked rows must be unique. A phrase borrows the rank
    # of its rarest component *by construction*, so it collides with that
    # component on purpose; including phrases here would fail every run.
    direct = [r["freq_rank"] for r in rows if r["basis"] != "phrase"]
    if len(set(direct)) != len(direct):
        problems.append("duplicate freq_rank values -- the ordering is not a ranking")

    if problems:
        for problem in problems:
            print(f"FAIL [{lang}]: {problem}", file=sys.stderr)
        return 1

    # (rank, lemma) so a phrase sorts right after the component it borrowed
    # from, and so re-running the stage produces a byte-identical artifact.
    rows.sort(key=lambda r: (r["freq_rank"], r["lemma"]))  # type: ignore[arg-type,return-value]
    out_path = OUT / str(spec["out"])
    OUT.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"{lang}: {ranked}/{len(lemmas)} lemmas ranked ({coverage:.1%}) -> {out_path.relative_to(ROOT)}")
    print(f"    subtitles vocab {len(subs_rank):>8}   wikipedia vocab {len(wiki_rank):>8}")
    for basis in ("blend", "subtitles", "wikipedia", "phrase", "unranked"):
        if basis_counts[basis]:
            print(f"    {basis:<10} {basis_counts[basis]:>6}")
    print(f"    first 12: {', '.join(str(r['lemma']) for r in rows[:12])}")
    return 0


def main() -> int:
    used: set[str] = set()
    for lang, spec in LANGUAGES.items():
        code = run(lang, spec)
        if code:
            return code
        used |= {SUBS_SOURCE, WIKI_SOURCE}

    manifest = write_manifest(used)
    print(f"attribution -> {manifest.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
