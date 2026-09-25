#!/usr/bin/env bash
# M6-03 after-measurements (run serialized, all on the rebuilt bundle
# binary): quiescent idle refresh count, watcher burst, baseline matrix,
# hist10k 60-click deep paging, hist200 paging supplement.
set -euo pipefail
binary="${1:?usage: after_m6_03.sh <release-binary>}"
here="$(cd "$(dirname "$0")" && pwd)"
root=/tmp/guit-m6-bench

# Never append onto a previous pass: each output starts from scratch.
rm -rf /tmp/guit-m6-after-quiet
find /tmp -maxdepth 1 -name 'guit-m6-after-*' -exec rm -rf {} +

echo "== quiescent idle: refreshes with zero external changes (12 s)"
qrepo=/tmp/guit-m6-after-quiet
bash "$here/make-repo.sh" "$qrepo" 1000 100 100 >/dev/null
git -C "$qrepo" status --porcelain=v2 -uall >/dev/null   # absorb stat refresh
git -C "$qrepo" status --porcelain=v2 -uall >/dev/null
work="$qrepo.home"; rm -rf "$work"; mkdir -p "$work/config/dev.guit.desktop" "$work/cache" "$work/run"
printf '{"schema_version":1,"path":"%s"}' "$qrepo" > "$work/config/dev.guit.desktop/session.json"
HOME="$work" XDG_CONFIG_HOME="$work/config" XDG_CACHE_HOME="$work/cache" \
  XDG_RUNTIME_DIR="$work/run" GUIT_PERF=1 setsid "$binary" >"$work/perf.log" 2>&1 &
pid=$!
sleep 12
kill -TERM -- "-$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
echo "quiescent watch.refresh=$(grep -c 'phase=watch.refresh' "$work/perf.log" || true)"
echo "quiescent git.status=$(grep -c 'phase=git.status' "$work/perf.log" || true)"

echo "== watcher burst coalescing on t10k-u10k (6 bursts x 10 files)"
bash "$here/burst_measure.sh" "$binary" "$root/t10k-u10k" 6 10 0.5 \
  > /tmp/guit-m6-after-burst.txt 2>&1
tail -3 /tmp/guit-m6-after-burst.txt

echo "== baseline matrix, 5 repeats x 4 cells"
bash "$here/run_matrix.sh" "$binary" 5 /tmp/guit-m6-after-baseline.jsonl

echo "== hist10k in-app 60-click deep paging"
/usr/bin/python3 "$here/bench_run.py" \
  --binary "$binary" --repo "$root/hist10k" \
  --label hist10k-warm-r1-after --idle 5 --history-pages 60 \
  --out /tmp/guit-m6-after-hist10k.1.json | tail -1 > /tmp/guit-m6-after-hist10k.jsonl

echo "== hist200 paging supplement, 5 repeats"
bash "$here/paging_supplement.sh" "$binary" 5 /tmp/guit-m6-after-paging.jsonl

echo "after-measurements done"
