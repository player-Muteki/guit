#!/usr/bin/env bash
# Build a guit UI-test repository with content for every view.
# Override the location with GUIT_UI_REPO=/some/path.
set -eu
export GIT_AUTHOR_NAME="guit ui" GIT_AUTHOR_EMAIL=ui@example.invalid
export GIT_COMMITTER_NAME="guit ui" GIT_COMMITTER_EMAIL=ui@example.invalid
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/nonexistent-guit-ui-config
R="${GUIT_UI_REPO:-/tmp/guit-ui-repo}"
rm -rf "$R" "$R-remote.git" "$R-side" "$R-wt2"
mkdir -p "$R" && cd "$R"
git init -q --initial-branch=main

# history: 12 commits with varied subjects (unicode, long, quotes)
for i in $(seq 1 12); do
  echo "line $i" >> notes.txt
  printf 'def f%d():\n    return %d\n' "$i" "$i" > "mod$i.py"
  git add -A && git commit -qm "commit number $i: adds feature $i and touches notes"
done
git commit -q --allow-empty -m 'A subject with "quotes" and '"'"'apostrophes'"'"' that is quite long so it must be truncated gracefully in the history row'
git commit -q --allow-empty -m "中文提交信息，包含标点符号"
git commit -q --allow-empty -m "$(printf 'x%.0s' {1..200})"
git tag v1.0 HEAD~3
git tag -a v2.0 -m "annotated tag" HEAD~1

# local bare "remote"
git init -q --bare "$R-remote.git"
git remote add origin "$R-remote.git"
git push -q -u origin main
git commit -q --allow-empty -m "ahead commit 1"
git commit -q --allow-empty -m "ahead commit 2"   # ahead 2, not pushed

# branches
git branch feature/narrow-window
git branch bugfix/中文分支

# stash
echo dirty >> notes.txt && git stash push -qm "wip: stash one"
echo more >> notes.txt && git stash push -qm "wip: stash two"

# worktree
git worktree add -q "$R-wt2" -b worktree/second

# conflicts: diverging edit on conflict.txt
mkdir -p src && echo "base" > src/file1.txt && git add src/file1.txt && git commit -qm "add src/file1"
git checkout -q -b side HEAD~4
echo "side line" > conflict.txt && git add conflict.txt && git commit -qm "side edits conflict"
git checkout -q main
echo "main line" > conflict.txt && git add conflict.txt && git commit -qm "main edits conflict"
git merge --no-commit --no-ff side || true   # leaves conflict state

# staged + unstaged + untracked + rename
echo "staged edit" >> notes.txt && git add notes.txt
echo "unstaged" >> mod3.py
mkdir -p "src/中文 目录" && echo hi > "src/中文 目录/文件 name.txt"
echo untracked > todo.txt
echo "dirty edit" >> src/file1.txt
git rm -q --cached mod1.py >/dev/null 2>&1 || true
git mv -k mod2.py mod2-renamed.py 2>/dev/null || true

git status --porcelain=v2 | head -20
echo "== repo ready: $R"
