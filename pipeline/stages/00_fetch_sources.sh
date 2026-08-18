#!/usr/bin/env bash
# Stage 0: download the open sources the pipeline builds on.
#
# Raw downloads are NOT checked in — they are large, unmodified, and freely
# re-fetchable. The derived artifacts in pipeline/artifacts/ are checked in,
# because those are what the loader reads and what a re-run must not have to
# recompute (PLAN.md §5).
set -euo pipefail

RAW="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/raw"
mkdir -p "$RAW"

fetch() {
  local url="$1" out="$2"
  if [[ -s "$RAW/$out" ]]; then
    echo "  have $out"
  else
    echo "  get  $out"
    curl -sSL --fail --max-time 600 -o "$RAW/$out" "$url"
  fi
}

echo "English — CEFR-J Vocabulary Profile (CC BY-SA 4.0)"
CEFRJ="https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master"
fetch "$CEFRJ/cefrj-vocabulary-profile-1.5.csv"        cefrj-vocabulary-profile-1.5.csv
fetch "$CEFRJ/octanove-vocabulary-profile-c1c2-1.0.csv" octanove-c1c2-1.0.csv
fetch "$CEFRJ/README.md"                                cefrj-README.md

echo "Italian — Nuovo vocabolario di base (extraction: public domain)"
NVDB="https://raw.githubusercontent.com/pettarin/nvdb/master"
fetch "$NVDB/nvdb.full.txt"          nvdb.full.txt
fetch "$NVDB/20170108.nvdb.pdf"      nvdb.pdf
fetch "$NVDB/README.md"              nvdb-README.md
fetch "$NVDB/article.md"             article.md

echo "Frequency — OpenSubtitles 2018 (FrequencyWords, content CC BY-SA 4.0)"
FW="https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018"
fetch "$FW/it/it_full.txt" it_full.txt
fetch "$FW/en/en_full.txt" en_full.txt

echo "Frequency — Wikipedia dumps (wikipedia-word-frequency-clean, BSD-3 script / CC BY-SA text)"
WWF="https://raw.githubusercontent.com/adno/wikipedia-word-frequency-clean/main/results"
fetch "$WWF/itwiki-frequency-20221020-nfkc-lower.tsv.xz" itwiki-frequency.tsv.xz
fetch "$WWF/enwiki-frequency-20221020-nfkc-lower.tsv.xz" enwiki-frequency.tsv.xz

echo "done. Sources in pipeline/raw/ (gitignored)."
