#!/usr/bin/env bash
# M6-02 untracked-depth sweep: capture latency and memory as a function of
# (tracked x untracked), short runs, many perf samples per run.
# Usage: sweep_untracked.sh <release-binary> [repeats-per-cell] [results.jsonl]
set -euo pipefail
binary="${1:?usage: sweep_untracked.sh <release-binary> [repeats] [results.jsonl]}"
repeats="${2:-3}"
out="${3:-/tmp/guit-m6-untracked.jsonl}"
root=/tmp/guit-m6-bench
mkdir -p "$root"
: > "$out"

cells=(
  "t100-u1k 100 1000 10"
  "t100-u10k 100 10000 10"
  "t1k-u1k 1000 1000 100"
  "t1k-u10k 1000 10000 100"
  "t10k-u1k 10000 1000 1000"
  "t10k-u10k 10000 10000 1000"
)

for spec in "${cells[@]}"; do
  read -r name tracked untracked dirty <<< "$spec"
  bash "$(dirname "$0")/make-repo.sh" "$root/$name" "$tracked" "$untracked" "$dirty" > /dev/null
  for run in $(seq 1 "$repeats"); do
    /usr/bin/python3 "$(dirname "$0")/bench_run.py" \
      --binary "$binary" \
      --repo "$root/$name" \
      --label "$name-warm-r$run" \
      --idle 8 \
      --out "$out.$name.$run.json" | tail -1 >> "$out"
  done
done
echo "untracked sweep done: $out"
