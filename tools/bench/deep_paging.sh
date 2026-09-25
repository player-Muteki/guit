#!/usr/bin/env bash
# M6-02 deep-paging curve at the Git layer: wall time of exactly the command
# guit runs per page (`git log --skip N -n 50 ...`). Raw milliseconds, no
# runner 20 ms floor mixed in; the in-app floor is spot-checked separately.
# Usage: deep_paging.sh <repo-with-many-commits> [repeats]
set -euo pipefail
repo="${1:?usage: deep_paging.sh <repo> [repeats]}"
repeats="${2:-5}"
for skip in 0 2500 5000 7500 9950; do
  times=()
  for _ in $(seq 1 "$repeats"); do
    t0=$(date +%s%3N)
    git -C "$repo" log --skip "$skip" -n 50 --format='%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x01' >/dev/null
    times+=("$(( $(date +%s%3N) - t0 ))")
  done
  printf 'skip=%-5s times_ms=%s\n' "$skip" "${times[*]}"
done
