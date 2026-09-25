#!/usr/bin/python3
"""Generate a repository with N commits via git fast-import (seconds, not the
hour a per-commit loop costs). Used by M6-01's paging supplement (200 commits)
and M6-02's deep-page curves (10,000 commits).

Usage: make-history.py <dir> <commits> [files-per-commit]

The repo gets a 100-file baseline tree, then `commits` total commits; each
later commit rewrites `files-per-commit` of the files with new blobs.
Identity is pinned inside the fast-import stream, so no git config is touched.
"""

import os
import shutil
import subprocess
import sys


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    target = sys.argv[1]
    commits = max(1, int(sys.argv[2]))
    per_commit = max(1, int(sys.argv[3])) if len(sys.argv) > 3 else 1

    if os.path.exists(target):
        shutil.rmtree(target)
    os.makedirs(target)
    subprocess.run(["git", "init", "-b", "main", target], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    out = bytearray()
    state = {"mark": 0}

    def blob(data):
        state["mark"] += 1
        out.extend(b"blob\nmark :%d\ndata %d\n%s\n" % (state["mark"], len(data), data))
        return state["mark"]

    marks = [blob(f"seed {i}\n".encode()) for i in range(100)]
    last_commit = [0]

    def emit_commit(message, first):
        # Measured order for Git 2.53 fast-import: commit, committer, message,
        # then the parent link and file changes. Parents are referenced by
        # commit marks within one stream; `refs/heads/main^0` does not resolve
        # for a branch created earlier in the same stream.
        payload = bytearray()
        state["mark"] += 1
        commit_mark = state["mark"]
        payload += (
            b"commit refs/heads/main\n"
            + b"mark :%d\n" % commit_mark
            + b"committer guit-bench <bench@invalid> 0 +0000\n"
            b"data <<MSG\n" + message.encode() + b"\nMSG\n"
            + (b"" if first else b"from :%d\n" % last_commit[0])
        )
        for slot, mark in enumerate(marks):
            payload += b"M 644 :%d src/file%d.txt\n" % (mark, slot)
        payload += b"\n"
        out.extend(payload)
        last_commit[0] = commit_mark

    emit_commit("seed", first=True)
    for n in range(1, commits):
        for j in range(per_commit):
            slot = (n * 7 + j) % 100
            marks[slot] = blob(f"commit {n} file {slot}\n".encode())
        emit_commit(f"change {n}", first=False)

    subprocess.run(
        ["git", "--git-dir", os.path.join(target, ".git"), "fast-import", "--quiet"],
        input=bytes(out), check=True)
    subprocess.run(
        ["git", "-C", target, "checkout", "-f", "main"],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    count = subprocess.run(
        ["git", "-C", target, "rev-list", "--count", "main"],
        check=True, capture_output=True, text=True).stdout.strip()
    print(f"{target}: {count} commits")
    return 0


if __name__ == "__main__":
    sys.exit(main())
