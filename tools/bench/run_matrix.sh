#!/usr/bin/env bash
# M6-01 baseline matrix: for each fixture size, run the harness N times and
# append one JSON line per run to the results file. Median/outlier reduction
# happens in the validation record. Usage:
#   run_matrix.sh <release-binary> <repeats> [results.jsonl]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
binary="${1:?usage: run_matrix.sh <release-binary> <repeats> [results.jsonl]}"
repeats="${2:?}"
out="${3:-/tmp/guit-m6-baseline.jsonl}"
bench=/usr/bin/python3
fixtures=/tmp/guit-m6-bench

mkdir -p "$fixtures"
touch "$out"

# size:tracked untracked dirty
cells=(
  "tiny 1 0 0"
  "100 100 0 10"
  "1k 1000 0 100"
  "10k 10000 0 1000"
)

for cell in "${cells[@]}"; do
  read -r name tracked untracked dirty <<<"$cell"
  repo="$fixtures/$name"
  for run in $(seq 1 "$repeats"); do
    if [ "$run" -eq 1 ]; then
      "$here/make-repo.sh" "$repo" "$tracked" "$untracked" "$dirty" >/dev/null
      first=cold
    else
      first=warmed
    fi
    "$bench" "$here/bench_run.py" \
      --binary "$binary" \
      --repo "$repo" \
      --label "$name-$first-r$run" \
      --idle 30 \
      --touch \
      --history-pages 0 \
      --out "$out.$name.$first.$run.json" | tail -1 >> "$out"
  done
done
echo "matrix done: $out (full per-run records next to it as $out.NAME.MODE.N.json)"
