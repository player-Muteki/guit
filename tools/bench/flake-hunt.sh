#!/usr/bin/env bash
# Phase 1 feedback loop for the flaky Rust unit test.
#
# Runs the already-built *test harness* N times and tallies which tests fail.
# A flake is only debuggable once you can name it, and the point here is to
# turn a low-rate flake into one frequent enough to reason about.
#
#   Usage: flake-hunt.sh <rounds> [parallel] [test-name]
#
#   The optional test name runs only that test (`--exact`), which is how a
#   flake that has been named is then reproduced on its own.
#
# Exit status: 0 only when every round ran and every round passed. A round that
# left no record is reported as a failure of the harness, never as a pass: a
# tally that counts missing evidence as green cannot be trusted about the runs
# it did measure either.
#
# Picking the binary is the sharp edge here, and getting it wrong launches the
# GUI: `deps/` holds BOTH the test harness and the application, and the
# application ignores `--list`, opens a window and blocks. So the binary is
# identified by *asking* it, not by guessing from its name or mtime, and the
# script refuses to run anything that does not answer like a harness.
set -uo pipefail
cd "$(dirname "$0")/../../app" || exit 2

ROUNDS=${1:-40}
PAR=${2:-8}
ONLY=${3:-}

case "$ROUNDS" in ''|*[!0-9]*) echo "rounds must be a number" >&2; exit 2;; esac
case "$PAR" in ''|*[!0-9]*) echo "parallel must be a number" >&2; exit 2;; esac
[ "$ROUNDS" -gt 0 ] || { echo "rounds must be at least 1" >&2; exit 2; }
[ "$PAR" -gt 0 ] || PAR=1

pick_harness() {
  for b in src-tauri/target/debug/deps/guit-*; do
    case "$b" in *.d) continue ;; esac
    [ -x "$b" ] || continue
    # A test harness lists its tests and exits at once. The application ignores
    # the flag, opens a window and never returns, so it is bounded by `timeout`.
    if timeout 5 "$b" --list 2>/dev/null | head -1 | grep -q ': test'; then
      printf '%s\n' "$b"
      return 0
    fi
  done
  return 1
}

BIN=$(pick_harness)
if [ -z "$BIN" ]; then
  echo "no test harness found; run: cargo test --no-run" >&2
  exit 2
fi

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

# The per-round work goes in its own script file rather than an inline
# `sh -c` string: nesting printf's %s inside xargs' -I{} quoting is what
# silently wrote a literal "%s %s" into the tally and made every round look
# like a failure. A file has no quoting layer to get wrong.
cat > "$OUT/one.sh" <<EOF
#!/bin/sh
if [ -n "\$ONLY_TEST" ]; then
  "$BIN" --test-threads=4 --exact "\$ONLY_TEST" > "$OUT/run-\$1.log" 2>&1
else
  "$BIN" --test-threads=4 > "$OUT/run-\$1.log" 2>&1
fi
echo "\$1 \$?" >> "$OUT/codes"
EOF
chmod +x "$OUT/one.sh"

echo "harness : $BIN"
echo "rounds  : $ROUNDS  parallel: $PAR${ONLY:+  filter: $ONLY (--exact)}"
echo

export ONLY_TEST="$ONLY"
seq 1 "$ROUNDS" | xargs -P "$PAR" -I{} "$OUT/one.sh" {}

recorded=$(wc -l < "$OUT/codes" 2>/dev/null || echo 0)
fails=$(awk '$2 != 0' "$OUT/codes" 2>/dev/null | wc -l)
echo "rounds recorded: $recorded / $ROUNDS"
echo "=== $fails / $ROUNDS runs failed ==="
echo
echo "=== failing tests, by frequency ==="
grep -hE '^(test .* FAILED|---- .* stdout ----)' "$OUT"/run-*.log 2>/dev/null \
  | sed -E 's/^test (.*) FAILED.*/\1/; s/^---- (\S+) stdout ----/\1/' \
  | sort | uniq -c | sort -rn
echo
echo "=== panic messages, by frequency ==="
grep -hA3 '^---- .* stdout ----' "$OUT"/run-*.log 2>/dev/null \
  | grep -E 'panicked at|assertion' | sed -E 's/^.*panicked at //' \
  | sort | uniq -c | sort -rn | head -20
echo

if [ "$recorded" -ne "$ROUNDS" ]; then
  echo "INCOMPLETE: $((ROUNDS - recorded)) of $ROUNDS rounds left no record;" >&2
  echo "this run says nothing either way about the tests it did not run." >&2
  exit 3
fi

if [ "$fails" -gt 0 ]; then
  exit 1
fi
echo "every round ran and passed"
