#!/usr/bin/env bash
# M6-02 phase 2 (run AFTER sweep_untracked.sh; all measurements serialized):
# hist10k fixture -> raw deep-page curve -> in-app deep-page spot check ->
# watcher burst coalescing on the biggest fixture.
set -euo pipefail
binary="${1:?usage: phase2_measures.sh <release-binary>}"
here="$(dirname "$0")"
root=/tmp/guit-m6-bench

/usr/bin/python3 "$here/make-history.py" "$root/hist10k" 10000 2
echo "== raw deep-page curve (skip 0..9950)"
bash "$here/deep_paging.sh" "$root/hist10k" 5 | tee /tmp/guit-m6-deeppage.txt

echo "== in-app deep paging spot check (60 clicks from page 2)"
/usr/bin/python3 "$here/bench_run.py" \
  --binary "$binary" --repo "$root/hist10k" \
  --label hist10k-warm-r1 --idle 5 --history-pages 60 \
  --out /tmp/guit-m6-hist10k.1.json | tail -1 > /tmp/guit-m6-hist10k.jsonl

echo "== watcher burst coalescing on t10k-u10k (6 bursts x 10 files, 0.5 s apart)"
bash "$here/burst_measure.sh" "$binary" "$root/t10k-u10k" 6 10 0.5 \
  > /tmp/guit-m6-burst.txt 2>&1
grep -c 'phase=watch.refresh' /tmp/guit-m6-burst.txt || true
tail -6 /tmp/guit-m6-burst.txt
echo "phase2 done"
