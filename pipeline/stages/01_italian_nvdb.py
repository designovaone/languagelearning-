"""
Stage 1 (Italian): the curated word list and its usage bands.

Nuovo vocabolario di base (De Mauro & Chiari, 2016). ~7,000 lemmas in three
usage bands: FO fondamentale, AU alto uso, AD alta disponibilita.

WHY THIS READS THE PDF AND NOT THE PLAIN-TEXT EXTRACTION
--------------------------------------------------------
The published list encodes the band as *typography*, stated in the article
that accompanies it: fondamentale in bold, alto uso in regular, alta
disponibilita in italic. Every plain-text extraction therefore loses the band
-- `nvdb.full.txt` has all 7,248 lemmas and zero band markers.

The band is the spine of the Italian deck (PLAN.md SS5: "which words exist" and
"what order to learn them in" both come from the curated list), so it is worth
reading the fonts back out of the PDF rather than falling back to frequency.

Membership and grammar come from `nvdb.full.txt`, which is already correctly
parsed. This file only decides which of the three bands each lemma sits in.

Input : pipeline/raw/nvdb.pdf, pipeline/raw/nvdb.full.txt
Output: pipeline/artifacts/it-01-words.jsonl
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

import pymupdf

from _sources import write_manifest

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "pipeline" / "raw"
OUT = ROOT / "pipeline" / "artifacts"

BODY_SIZE = 9.8
SIZE_TOLERANCE = 0.3

FONT_TO_BAND = {
    "LyonText-Bold": "FO",
    "LyonText-RegularItalic": "AD",
}
DEFAULT_BAND = "AU"

BAND_NUMBER = {"FO": 1, "AU": 2, "AD": 3}
BAND_NAME = {
    "FO": "Fondamentale",
    "AU": "Alto uso",
    "AD": "Alta disponibilita",
}

SOURCE_ID = "nvdb"

# Published figures from the article, used as a sanity range rather than an
# exact target: the list is described as "circa" in every band.
EXPECTED = {"FO": (1900, 2300), "AU": (2600, 3200), "AD": (2100, 2700)}


def styled_headwords(pdf_path: Path) -> dict[str, set[str]]:
    """
    Lemmas printed in bold and in italic, taken straight from the fonts.

    Built as a character stream rather than span by span, because the PDF
    hyphenates across line breaks with a soft hyphen (U+00AD): "acceca-" ends
    one line and "mento" begins the next, in two separate spans. Reading spans
    individually yields 158 fragments that match no lemma -- which is how this
    was found, since the stage refuses to write a list whose styled headwords
    do not line up with the entries.
    """
    found: dict[str, set[str]] = {"FO": set(), "AD": set()}
    doc = pymupdf.open(pdf_path)

    for page in doc:
        chars: list[tuple[str, str]] = []
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    if abs(span["size"] - BODY_SIZE) > SIZE_TOLERANCE:
                        continue  # headers, page numbers, section letters, homograph superscripts
                    for ch in span["text"]:
                        chars.append((ch, span["font"]))

        # Drop soft hyphens so a word broken over two lines becomes one token.
        joined = [(c, f) for c, f in chars if c != "\xad"]

        # Walk maximal runs of one font, then split each run into words.
        run_font: str | None = None
        run_text: list[str] = []
        for ch, font in joined + [("\n", "")]:
            if font != run_font:
                _collect(found, run_font, "".join(run_text))
                run_font, run_text = font, [ch]
            else:
                run_text.append(ch)
        _collect(found, run_font, "".join(run_text))

    doc.close()
    return found


def _collect(found: dict[str, set[str]], font: str | None, text: str) -> None:
    band = FONT_TO_BAND.get(font or "")
    if band is None:
        return
    for token in re.split(r"[\s,;]+", text):
        word = normalise(token)
        if not word or not word[0].isalpha():
            continue
        if len(token.strip()) == 1 and token.strip().isupper():
            continue  # a section letter set at body size
        found[band].add(word)


def normalise(word: str) -> str:
    """Strip the superscript homograph marker and fold case."""
    return re.sub(r"^\d+", "", word).strip().lower()


def parse_full_text(path: Path) -> list[tuple[str, str]]:
    """(lemma, grammar) for every entry, from the already-parsed extraction."""
    entries: list[tuple[str, str]] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split(" ", 1)
        lemma = normalise(parts[0])
        grammar = parts[1].strip() if len(parts) > 1 else ""
        if lemma:
            entries.append((lemma, grammar))
    return entries


def main() -> int:
    pdf = RAW / "nvdb.pdf"
    full = RAW / "nvdb.full.txt"
    for path in (pdf, full):
        if not path.exists():
            print(f"missing input: {path}", file=sys.stderr)
            return 2

    styled = styled_headwords(pdf)
    entries = parse_full_text(full)

    # A lemma can appear in two bands when the list carries homographs
    # (1a the letter, 2a the preposition). Take the more common band: the
    # learner should meet the frequent sense first.
    rows = []
    bands = Counter()
    for lemma, grammar in entries:
        if lemma in styled["FO"]:
            band = "FO"
        elif lemma in styled["AD"]:
            band = "AD"
        else:
            band = DEFAULT_BAND
        bands[band] += 1
        rows.append(
            {
                "lemma": lemma,
                "grammar": grammar,
                "band": band,
                "band_number": BAND_NUMBER[band],
                "band_name": BAND_NAME[band],
                "scheme": "nvdb",
                "band_source": "nvdb",
                "source_id": SOURCE_ID,
            }
        )

    # Fail loudly rather than emit a deck whose spine is quietly wrong. A
    # silently mis-banded list would still load, still drill, and teach in the
    # wrong order -- with no error anywhere.
    problems = []
    if len(rows) < 6800 or len(rows) > 7600:
        problems.append(f"expected ~7,250 lemmas, got {len(rows)}")
    for band, (low, high) in EXPECTED.items():
        if not low <= bands[band] <= high:
            problems.append(f"band {band}: expected {low}-{high}, got {bands[band]}")
    unmatched = (styled["FO"] | styled["AD"]) - {r["lemma"] for r in rows}
    if len(unmatched) > 60:
        problems.append(
            f"{len(unmatched)} styled headwords matched no entry, e.g. {sorted(unmatched)[:8]}"
        )
    if problems:
        for p in problems:
            print(f"FAIL: {p}", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "it-01-words.jsonl"
    with out_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    manifest = write_manifest({SOURCE_ID})

    print(f"wrote {len(rows)} lemmas -> {out_path.relative_to(ROOT)}")
    print(f"attribution -> {manifest.relative_to(ROOT)}")
    for band in ("FO", "AU", "AD"):
        print(f"  {band} {BAND_NAME[band]:<22} {bands[band]:>5}")
    print(f"  (styled headwords with no matching entry: {len(unmatched)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
