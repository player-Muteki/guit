#!/usr/bin/env bash
# M6-01 supplement: history-paging baseline on a 200-commit fixture, plus the
# bounded VS Code SCM reference on the 10k fixture. Run AFTER run_matrix.sh so
# the measurements never overlap.
set -euo pipefail
binary="${1:?usage: paging_supplement.sh <release-binary> [repeats] [results.jsonl]}"
repeats="${2:-5}"
out="${3:-/tmp/guit-m6-paging.jsonl}"
root=/tmp/guit-m6-bench
mkdir -p "$root"

if [ ! -d "$root/hist200/.git" ]; then
  /usr/bin/python3 "$(dirname "$0")/make-history.py" "$root/hist200" 200 2
fi

: > "$out"
for run in $(seq 1 "$repeats"); do
  mode=$([ "$run" -eq 1 ] && echo cold || echo warmed)
  /usr/bin/python3 "$(dirname "$0")/bench_run.py" \
    --binary "$binary" \
    --repo "$root/hist200" \
    --label "hist200-$mode-r$run" \
    --idle 10 \
    --history-pages 4 \
    --out "$out.hist200.$mode.$run.json" | tail -1 >> "$out"
done

# Bounded reference: VS Code SCM sidebar on the same 10k fixture, one run set.
if [ -d "$root/10k" ] && command -v /usr/bin/code >/dev/null; then
  /usr/bin/python3 "$(dirname "$0")/vscode_ref.py" \
    --repo "$root/10k" --out /tmp/guit-m6-vscode-ref.json
fi
echo "supplement done: $out"
