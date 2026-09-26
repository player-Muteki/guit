#!/usr/bin/env bash
# A bench fixture that is actually dirty: make-repo.sh's `dirty` count appends
# before the commit, so its working copy is clean and no file row ever renders.
# This one commits first and dirties afterwards, so the populated-list path
# (rows, groups, per-row menus, the discard ticket) is what gets measured.
# Usage: make-dirty-repo.sh <dir> <tracked> <dirty> [untracked]
set -euo pipefail

if [ $# -lt 3 ]; then
  echo "usage: make-dirty-repo.sh <dir> <tracked> <dirty> [untracked]" >&2
  exit 2
fi

dir="$1"; tracked="$2"; dirty="$3"; untracked="${4:-0}"
rm -rf "$dir"; mkdir -p "$dir"

python3 - "$dir" "$tracked" "$untracked" "$dirty" <<'PY'
import os, sys
root, tracked, untracked, dirty = sys.argv[1], *map(int, sys.argv[2:])
body = "guit bench fixture line\n" * 40

def write(rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)

names = []
for i in range(tracked):
    rel = f"src/dir{i // 100}/file{i}.txt" if i >= 100 and i % 100 == 99 else f"src/file{i}.txt"
    write(rel, body)
    names.append(rel)
for i in range(untracked):
    write(f"untracked/u{i}.txt", body)
with open(os.path.join(root, ".dirty"), "w", encoding="utf-8") as handle:
    handle.write("\n".join(names[:max(0, dirty)]))
PY

g=(git -C "$dir" -c user.name=guit-bench -c user.email=bench@invalid -c commit.gpgsign=false)
"${g[@]}" init -q -b main
"${g[@]}" add -- src
"${g[@]}" commit -q -m "bench fixture"
# Now make the working copy dirty: modify every listed file, stage every other
# one, and delete a few. Nothing is committed, so the snapshot carries staged
# changes, unstaged changes, deletions and untracked files at the same time.
staged_list="$dir/.staged"
python3 - "$dir" "$staged_list" <<'PY'
import os, sys
root, staged_list = sys.argv[1], sys.argv[2]
with open(os.path.join(root, ".dirty"), encoding="utf-8") as handle:
    names = [line for line in handle.read().splitlines() if line]
os.remove(os.path.join(root, ".dirty"))
staged = []
for index, rel in enumerate(names):
    path = os.path.join(root, rel)
    if index % 5 == 4 and os.path.exists(path):
        os.remove(path)          # a deleted file
        continue
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("dirty\n")
    if index % 2 == 0:
        staged.append(rel)
with open(staged_list, "wb") as handle:
    handle.write(b"".join(rel.encode("utf-8") + b"\0" for rel in staged))
PY
# Stage only the listed half; the rest stays unstaged. A NUL-delimited
# pathspec file keeps the non-ASCII and spaced names the fixture also
# generates intact.
"${g[@]}" add -A --pathspec-from-file="$staged_list" --pathspec-file-nul
rm -f "$staged_list"
echo "fixture $dir: tracked=$tracked dirty=$dirty untracked=$untracked (staged, unstaged, deleted and untracked all present)"
