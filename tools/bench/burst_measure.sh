#!/usr/bin/env bash
# M6-02 watcher burst test: how many refresh captures does a file-event burst
# produce (debounce + coalescing gate) on the 10k-directory fixture, and what
# does the poll fallback cost at idle.
# Usage: burst_measure.sh <release-binary> <repo> [bursts] [files-per-burst] [interval-s]
set -euo pipefail
binary="${1:?usage: burst_measure.sh <release-binary> <repo> [bursts] [files-per-burst] [interval]}"
repo="$2"
bursts="${3:-6}"
files="${4:-10}"
interval="${5:-0.5}"
work="${repo}.burst"
rm -rf "$work"; mkdir -p "$work/config" "$work/cache" "$work/run"
mkdir -p "$work/config/dev.guit.desktop"
cat > "$work/config/dev.guit.desktop/session.json" <<EOF
{"schema_version":1,"path":"$repo"}
EOF
export HOME="$work" XDG_CONFIG_HOME="$work/config" XDG_CACHE_HOME="$work/cache" XDG_RUNTIME_DIR="$work/run"
log="$work/perf.log"
GUIT_PERF=1 setsid "$binary" >"$log" 2>&1 &
pid=$!
sleep 4  # let restore + watcher attach
/usr/bin/python3 "$(dirname "$0")/storm.py" "$repo" "$files" "$bursts" "$interval"
sleep 4  # let the last refresh settle
kill -TERM -- "-$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
refreshes=$(grep -c 'phase=watch.refresh' "$log" || true)
heartbeats=$(grep -c 'phase=git.status' "$log" || true)
echo "bursts=$bursts files_per_burst=$files interval=${interval}s"
echo "git.status captures total=$heartbeats watch.refresh=$refreshes"
grep 'phase=watch.refresh' "$log" | tail -40
