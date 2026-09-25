#!/usr/bin/env bash
# Generate a deterministic measurement fixture for the guit M6 benchmarks.
# Usage: make-repo.sh <dir> <tracked> <untracked> [dirty]
# Isolated Git identity via -c flags only; never touches user config. The
# directory is recreated from scratch so page-cache state is reproducible.
set -euo pipefail

if [ $# -lt 3 ]; then
  echo "usage: make-repo.sh <dir> <tracked> <untracked> [dirty]" >&2
  exit 2
fi

dir="$1"; tracked="$2"; untracked="$3"; dirty="${4:-0}"

rm -rf "$dir"
mkdir -p "$dir"

python3 - "$dir" "$tracked" "$untracked" "$dirty" <<'PY'
import os, sys

root, tracked, untracked, dirty = sys.argv[1], *map(int, sys.argv[2:])

def write(rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)

body = "guit bench fixture line\n" * 40  # ~1.2 KB

# Tracked files: flat under src/, plus one nested directory per 100 files.
names = []
for i in range(tracked):
    if i % 100 == 99 and i >= 100:
        rel = f"src/dir{i // 100}/file{i}.txt"
    elif i % 37 == 0 and i < 200:
        rel = f"src/文件 {i}.txt"  # non-ASCII + space, in the first 200
    else:
        rel = f"src/file{i}.txt"
    write(rel, body)
    names.append(rel)

for i in range(untracked):
    write(f"untracked/u{i}.txt", body)

# Dirty subset: append a line to every Nth tracked file (target ~10%).
for name in names[:max(0, dirty)]:
    path = os.path.join(root, name)
    if os.path.exists(path):
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("dirty\n")
PY

git -C "$dir" -c user.name=guit-bench -c user.email=bench@invalid -c commit.gpgsign=false \
  init -q -b main
git -C "$dir" -c user.name=guit-bench -c user.email=bench@invalid -c commit.gpgsign=false \
  add -- src
git -C "$dir" -c user.name=guit-bench -c user.email=bench@invalid -c commit.gpgsign=false \
  commit -q -m "bench fixture"
# Only tracked files made it into the commit; untracked ones stay untracked.
echo "fixture $dir: tracked=$tracked untracked=$untracked dirty=$dirty"
