#!/usr/bin/env python3
"""What Git itself does to a working tree when the panel wants it restored to a commit.

"Reset to a clean state" is one sentence with several Git processes behind it: move
HEAD, make the index and the tracked working tree match the target, and remove the
untracked files in scope. Which paths each of those touches — and which Git refuses,
overwrites or never mentions — is what the preview of that operation has to promise
accurately, so the questions are asked of Git rather than assumed. Every line this
prints is Git's own exit status, stdout, stderr and the state of the files afterwards,
on a scratch repository built in a temporary directory and thrown away; it never opens
a repository the panel has.

    python3 tools/bench/clean-reset-probe.py

It asserts nothing on purpose: the answers belong to the installed Git and would move
with its version, so a run is read rather than passed. The questions it exists to
answer are:

  * when the target tree tracks a path the working tree holds untracked, does each way
    of moving the tree refuse or overwrite it — including when the bytes on disk are
    identical to the target's, and when the names differ only by case;
  * what a path that is a file in HEAD and a directory in the target does to each
    command, and the reverse;
  * what happens when the folded directory `clean -nd` offers contains a file the restore is
    about to write: whether a clean naming the folded entry removes the restored file with
    it, and what each way of naming paths to clean leaves the tree as;
  * whether any of the five refuses to destroy a nested repository sitting at a path the
    target holds as a file, with a file that repository itself tracks inside it;
  * whether a file the repository ignores is still overwritten by the target, and
    whether any listing of "what would be removed" ever offers to remove it;
  * which paths each listing shows and hides: `status --porcelain` with and without
    `-uall` and `--ignored`, `diff --name-only HEAD <target>`, `clean -nd` with and
    without `-x`, `ls-files --others` without the ignore rules, with them, and with
    them inverted to name only the ignored paths, and a
    nested repository or submodule in each — including which of them report an
    untracked directory folded into one entry instead of file by file;
  * whether a hard reset reaches inside a submodule's working tree at all;
  * what "clean" is checkable as once both steps ran, and which protected objects keep
    that condition from ever being reached;
  * whether the paths a restore will overwrite can be named *before* it runs — from the
    target's own tree listing against the untracked one — and whether that prediction
    matches the files whose bytes actually changed;
  * what the reads a preview is built from cost on a tree large enough to matter.

Every command that *moves* the tree is asked in a freshly built repository, because the
answer the next command would give is already changed by the one before it.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# Every scratch repository this builds, so the run leaves nothing behind.
CREATED: list[str] = []


def git(cwd: str, *args: str) -> tuple[int, str, str]:
    proc = subprocess.run(
        ["git", *args],
        cwd=cwd,
        env={
            **os.environ,
            "LC_ALL": "C",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_AUTHOR_DATE": "2020-01-01T00:00:00+00:00",
            "GIT_COMMITTER_DATE": "2020-01-01T00:00:00+00:00",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def commit(cwd: str, message: str) -> str:
    git(cwd, "add", "-A", "--")
    git(cwd, "commit", "-qm", message)
    return git(cwd, "rev-parse", "HEAD")[1]


def write(cwd: str, rel: str, text: str) -> None:
    path = Path(cwd, rel)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def fingerprint(cwd: str, rel: str) -> str:
    """What is on disk at one path: absent, a short digest of its exact bytes, or its members.

    "Refused" and "overwrote it" look identical in an exit status while the file is
    still there; only its bytes say which of the two happened.
    """
    path = Path(cwd, rel)
    if not path.exists():
        return "absent"
    if path.is_dir():
        return "dir:" + ",".join(sorted(entry.name for entry in path.iterdir()))
    return hashlib.sha1(path.read_bytes()).hexdigest()[:10]


def one_line(text: str, limit: int = 88) -> str:
    flat = " / ".join(line for line in text.splitlines() if line)
    return flat[:limit] or "-"


def head(root: str) -> str:
    return git(root, "rev-parse", "--short", "HEAD")[1]


def scratch(name: str) -> str:
    root = tempfile.mkdtemp(prefix=f"guit-clean-reset-{name}-")
    CREATED.append(root)
    git(root, "init", "-q", "--initial-branch=main")
    git(root, "config", "user.email", "probe@example.invalid")
    git(root, "config", "user.name", "probe")
    return root


def listing(root: str, label: str, args: list[str]) -> None:
    """One read that only *describes* the tree, printed as Git answers it."""
    rc, out, err = git(root, *args)
    entries = [piece for piece in (out.split("\0") if "-z" in args else out.splitlines()) if piece]
    print(f"    {label:46} rc={rc} {len(entries)} entry(ies){'  err=' + one_line(err, 40) if err else ''}")
    for entry in entries:
        print(f"    {'':46} | {one_line(entry, 64)}")


def ask(root: str, label: str, args: list[str], watched: list[str]) -> None:
    """One command that moves the tree, then the tree it left behind."""
    rc, out, err = git(root, *args)
    print(f"    {label:46} rc={rc}")
    if out or err:
        print(f"    {'':46} out={one_line(out, 40)}  err={one_line(err, 60)}")
    for rel in watched:
        print(f"    {'':46} {rel:18} {fingerprint(root, rel)}")
    print(
        f"    {'':46} HEAD={head(root)} "
        f"status={one_line(git(root, 'status', '--porcelain', '-uall')[1], 56)}"
    )


MOVES = [
    ("git reset --hard <target>", lambda target: ["reset", "--hard", target]),
    ("git checkout <target>", lambda target: ["checkout", target]),
    ("git switch --detach <target>", lambda target: ["switch", "--detach", target]),
    ("git checkout <target> -- .", lambda target: ["checkout", target, "--", "."]),
    (
        "git restore --source <target> --staged --worktree -- .",
        lambda target: ["restore", "--source", target, "--staged", "--worktree", "--", "."],
    ),
]


def obstruction_repo(held: str, bytes_on_disk: str) -> tuple[str, str]:
    """HEAD dropped a path; the target still tracks it; `held` sits untracked on disk.

    This is the ordinary shape of a deleted-then-recreated file, and the one case the
    preview has to describe: the path is both "untracked, so a clean would remove it"
    and "in the target tree, so the restore writes it".
    """
    root = scratch("obstruction")
    write(root, "keep.txt", "keep\n")
    write(root, "gone.txt", "the target's own bytes\n")
    target = commit(root, "both files tracked")
    os.remove(Path(root, "gone.txt"))
    commit(root, "gone.txt dropped from the tree")
    write(root, held, bytes_on_disk)
    return root, target


def scenario_obstruction() -> None:
    print("== an untracked file the target tree tracks ==")
    cases = [
        ("its bytes differ from the target's", "gone.txt", "written by hand, not the target's\n"),
        ("its bytes are identical to the target's", "gone.txt", "the target's own bytes\n"),
        ("the name differs only by case", "GONE.txt", "the target's own bytes\n"),
    ]
    for description, held, bytes_on_disk in cases:
        print(f"  --- untracked {held!r}: {description} (this file system is case-sensitive) ---")
        for label, build in MOVES:
            root, target = obstruction_repo(held, bytes_on_disk)
            ask(root, label.replace("<target>", target[:8]), build(target), [held, "gone.txt", "GONE.txt", "keep.txt"])


def file_to_directory_repo() -> tuple[str, str, str]:
    root = scratch("typedir")
    write(root, "x", "a file in HEAD\n")
    start = commit(root, "x is a file")
    git(root, "rm", "-q", "--", "x")
    write(root, "x/a", "inside a directory in the target\n")
    target = commit(root, "x is a directory")
    git(root, "checkout", "-q", start)
    return root, start, target


def directory_to_file_repo() -> tuple[str, str, str]:
    """A clean tracked file replaced by an untracked directory of the same name."""
    root = scratch("dirtofile")
    write(root, "keep.txt", "keep\n")
    write(root, "y", "a file the target will track\n")
    target = commit(root, "y is a file")
    git(root, "rm", "-q", "--", "y")
    commit(root, "y removed")
    write(root, "y/nested", "untracked inside a directory\n")
    return root, git(root, "rev-parse", "HEAD")[1], target


def target_paths(root: str, rev: str) -> list[str]:
    """Every path the target tree holds, as Git lists it."""
    out = git(root, "ls-tree", "-r", "-z", "--name-only", rev)[1]
    return [piece for piece in out.split("\0") if piece]


def untracked_paths(root: str) -> list[str]:
    """Every untracked path a clean would be offered, with the ignore rules applied."""
    out = git(root, "ls-files", "--others", "--exclude-standard", "-z")[1]
    return [piece for piece in out.split("\0") if piece]


def predict(root: str, target: str) -> list[str]:
    """Which untracked paths the restore will write over, without touching anything.

    Two shapes, measured in the scenarios above: the target holds the very same path, and
    the target holds a *file* whose name is a directory an untracked path sits inside.
    """
    held = set(target_paths(root, target))
    doomed = []
    for path in untracked_paths(root):
        if path in held:
            doomed.append(path)
            continue
        parts = path.split("/")
        for width in range(1, len(parts)):
            if "/".join(parts[:width]) in held:
                doomed.append(path)
                break
    return doomed


def scenario_prediction() -> None:
    """Can the preview name the overwritten paths before the write, and is the list right?"""
    print("== predicting what the restore overwrites, and what it actually overwrote ==")

    def untracked_file_in_target() -> tuple[str, str]:
        return obstruction_repo("gone.txt", "written by hand, not the target's\n")

    def identical_bytes_in_target() -> tuple[str, str]:
        return obstruction_repo("gone.txt", "the target's own bytes\n")

    def untracked_directory_against_a_file() -> tuple[str, str]:
        root, _start, target = directory_to_file_repo()
        return root, target

    for description, builder in (
        ("an untracked file the target also tracks", untracked_file_in_target),
        ("an untracked file holding the target's own bytes", identical_bytes_in_target),
        ("an untracked directory the target has as a file", untracked_directory_against_a_file),
    ):
        root, target = builder()
        before = {path: fingerprint(root, path) for path in untracked_paths(root)}
        predicted = sorted(predict(root, target))
        ask(root, "git reset --hard <target>", ["reset", "--hard", target], sorted(before))
        changed = sorted(path for path, seen in before.items() if fingerprint(root, path) != seen)
        print(f"  --- {description} ---")
        print(f"    untracked before  : {', '.join(sorted(before)) or '-'}")
        print(f"    predicted to lose : {', '.join(predicted) or '-'}")
        print(f"    actually changed  : {', '.join(changed) or '-'}")
        print(f"    the target's tree : {', '.join(target_paths(root, target)) or '-'}")

    print("  --- which listing says a local change is on a path the target deletes ---")
    root = scratch("deletes-dirty")
    write(root, "keep.txt", "keep\n")
    write(root, "doomed.txt", "as committed\n")
    target = commit(root, "both tracked")
    write(root, "doomed.txt", "a local change nobody staged\n")
    write(root, "keep.txt", "another local change\n")
    dirty = one_line(git(root, "status", "--porcelain")[1].replace("\n", " | "))
    git(root, "rm", "-q", "--", "doomed.txt")
    commit(root, "doomed.txt removed")
    print(f"    HEAD={head(root)}, restoring {target[:8]}")
    print(f"    status --porcelain             : {dirty}")
    print(f"    diff --name-only HEAD <target> : {', '.join(git(root, 'diff', '--name-only', 'HEAD', target)[1].splitlines())}")
    print("    a local change the restore discards is in both lists; neither one alone says it")


def scenario_type_change() -> None:
    print("== one path is a file in HEAD and a directory in the target ==")
    for builder, watched, which in (
        (file_to_directory_repo, ["x", "x/a"], "a clean tracked file, the target has a directory"),
        (directory_to_file_repo, ["y", "y/nested"], "an untracked directory, the target has a file"),
    ):
        print(f"  --- {which} ---")
        for label, build in MOVES:
            root, _start, target = builder()
            print(f"    on disk before: {watched[0]} = {fingerprint(root, watched[0])}, HEAD={head(root)}")
            ask(root, label.replace("<target>", target[:8]), build(target), watched)


def protected_repo() -> tuple[str, str, str]:
    """A tree holding one of each kind of thing a preview has to tell apart.

    `target` tracks `gone.txt`; HEAD, several commits later, does not — and the file is
    back on disk untracked. The other paths are the boundaries: an ignored directory, an
    ignored name, a nested repository, a submodule with something written inside it.
    """
    root = scratch("protected")
    write(root, ".gitignore", "ign/\nsecret.txt\n")
    write(root, "tracked.txt", "tracked\n")
    write(root, "gone.txt", "the target's own bytes\n")
    target = commit(root, "three files tracked")
    os.remove(Path(root, "gone.txt"))
    commit(root, "gone.txt dropped from the tree")
    other = scratch("foreign")
    write(other, "a.txt", "in another repository\n")
    commit(other, "foreign head")
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", other, "mod")
    head = commit(root, "a submodule added")
    nested = Path(root, "nested")
    nested.mkdir()
    git(str(nested), "init", "-q")
    git(str(nested), "config", "user.email", "probe@example.invalid")
    git(str(nested), "config", "user.name", "probe")
    write(str(nested), "README.md", "a nested repository\n")
    commit(str(nested), "nested head")
    write(root, "gone.txt", "untracked again, and the target tracks it\n")
    write(root, "plain.txt", "ordinary untracked\n")
    write(root, "ign/nested/deep.txt", "ignored, two levels deep\n")
    write(root, "secret.txt", "ignored by name\n")
    write(root, "tracked.txt", "tracked, and dirty\n")
    write(root, "mod/dirty.txt", "written inside the submodule\n")
    return root, head, target


def scenario_protected() -> None:
    print("== protected objects, and what each listing offers ==")
    root, _, target = protected_repo()
    print(f"  disk: nested/.git={'yes' if Path(root, 'nested/.git').exists() else 'no'} "
          f"mod/.git={'yes' if Path(root, 'mod/.git').exists() else 'no'}")
    for label, args in (
        ("status --porcelain", ["status", "--porcelain"]),
        ("status --porcelain -uall", ["status", "--porcelain", "-uall"]),
        ("status --porcelain -uall --ignored", ["status", "--porcelain", "-uall", "--ignored"]),
        ("status --porcelain -z -uall", ["status", "--porcelain", "-z", "-uall"]),
        ("clean -nd", ["clean", "-nd"]),
        ("clean -ndx", ["clean", "-ndx"]),
        ("clean -ndff", ["clean", "-ndff"]),
        ("clean -ndffx", ["clean", "-ndffx"]),
        ("clean -nd -- plain.txt (scoped)", ["clean", "-nd", "--", "plain.txt"]),
        ("clean -nd -- nested (scoped, a repository)", ["clean", "-nd", "--", "nested"]),
        ("clean -nd -- mod (scoped, a submodule)", ["clean", "-nd", "--", "mod"]),
        ("diff --name-only HEAD <target>", ["diff", "--name-only", "HEAD", target]),
        ("ls-files --others", ["ls-files", "--others"]),
        ("ls-files --others --exclude-standard", ["ls-files", "--others", "--exclude-standard"]),
        ("ls-files --others --ignored --exclude-standard",
         ["ls-files", "--others", "--ignored", "--exclude-standard"]),
        ("submodule status", ["submodule", "status"]),
    ):
        listing(root, label.replace("<target>", target[:8]), args)
    print("  --- does a hard reset reach inside a submodule or a nested repository? ---")
    print(f"    before: mod/dirty.txt = {fingerprint(root, 'mod/dirty.txt')}, nested/README.md = {fingerprint(root, 'nested/README.md')}")
    ask(root, "git reset --hard <target>", ["reset", "--hard", target], ["mod", "nested", "plain.txt", "gone.txt", "ign"])
    print(f"    after:  mod/dirty.txt = {fingerprint(root, 'mod/dirty.txt')}, nested/README.md = {fingerprint(root, 'nested/README.md')}")
    print(f"    after:  clean -nd still says {one_line(git(root, 'clean', '-nd')[1])}")

    print("  --- the target tracks a path the repository ignores ---")
    root = scratch("ignored-target")
    write(root, ".gitignore", "built.txt\n")
    write(root, "built.txt", "the target's own bytes\n")
    # `add -A` skips this file: the rule is already in place. The whole point of the
    # shape is a path the rules cover *and* the tree tracks, so it goes in by force —
    # and the target's own listing is printed, because a fixture that quietly fails to
    # track the path measures a different question.
    git(root, "add", "-f", "--", "built.txt")
    target = commit(root, "built.txt tracked despite the rule")
    print(f"    the target holds: {one_line(git(root, 'ls-tree', '-r', '--name-only', target)[1])}")
    rc, _out, _err = git(root, "rm", "--cached", "-q", "--", "built.txt")
    print(f"    git rm --cached now: rc={rc}")
    commit(root, "built.txt untracked, and ignored")
    rc, out, _ = git(root, "check-ignore", "-v", "built.txt")
    print(f"    check-ignore -v: rc={rc} {one_line(out)}")
    listing(root, "status --porcelain -uall --ignored", ["status", "--porcelain", "-uall", "--ignored"])
    listing(root, "ls-files --others --ignored --exclude-standard",
            ["ls-files", "--others", "--ignored", "--exclude-standard"])
    listing(root, "clean -ndx", ["clean", "-ndx"])
    ask(root, "git reset --hard <target>", ["reset", "--hard", target], ["built.txt"])
    rc, out, _ = git(root, "check-ignore", "-v", "built.txt")
    print(f"    the same path is tracked now: check-ignore -v rc={rc} {one_line(out)}")
    rc, out, _ = git(root, "check-ignore", "-v", "--no-index", "built.txt")
    print(f"    with --no-index the same rule is reported again: rc={rc} {one_line(out)}")


def folded_repo() -> tuple[str, str]:
    """The target tracks one file inside a directory HEAD does not know at all.

    `clean -nd` reports that directory as a single folded entry while
    `ls-files --others` reports its files one by one, so the removal promise and the
    overwrite list arrive at different granularity — and the folded entry covers a
    path the restore is about to write.
    """
    root = scratch("folded")
    write(root, "keep.txt", "keep\n")
    write(root, "extra/wanted.txt", "the target's own bytes\n")
    target = commit(root, "extra/wanted.txt tracked")
    git(root, "rm", "-q", "-r", "--", "extra")
    commit(root, "the whole directory dropped")
    write(root, "extra/wanted.txt", "written again by hand\n")
    write(root, "extra/other.txt", "and a sibling nobody tracked\n")
    return root, target


def scenario_folded_directory() -> None:
    print("== a folded untracked directory, half of it written by the restore ==")
    watched = ["extra", "extra/wanted.txt", "extra/other.txt"]
    for label, args in (
        ("git clean -fd -- extra", ["clean", "-fd", "--", "extra"]),
        (
            "git clean -fd -- extra/wanted.txt extra/other.txt",
            ["clean", "-fd", "--", "extra/wanted.txt", "extra/other.txt"],
        ),
        (
            "git clean -fd -- extra/other.txt",
            ["clean", "-fd", "--", "extra/other.txt"],
        ),
    ):
        root, target = folded_repo()
        listing(root, "before: clean -nd", ["clean", "-nd"])
        listing(
            root,
            "before: ls-files --others --exclude-standard -z",
            ["ls-files", "--others", "--exclude-standard", "-z"],
        )
        ask(root, f"git reset --hard {target[:8]}", ["reset", "--hard", target], watched)
        listing(root, "between: clean -nd after the reset", ["clean", "-nd"])
        ask(root, label, args, watched)
        print(
            f"    {'':46} status now={one_line(git(root, 'status', '--porcelain', '-uall')[1]) or '-'}"
        )
        print(
            f"    {'':46} matches the target? rc={git(root, 'diff', '--quiet', target)[0]}"
        )
        print()


def repo_in_the_way_repo() -> tuple[str, str]:
    """HEAD holds nothing where the target has a file, and a repository lives there."""
    root = scratch("repoaway")
    write(root, "keep.txt", "keep\n")
    write(root, "y", "the target's own bytes\n")
    target = commit(root, "y is a file")
    git(root, "rm", "-q", "--", "y")
    commit(root, "y dropped from the tree")
    nested = Path(root, "y")
    nested.mkdir()
    git(str(nested), "init", "-q")
    git(str(nested), "config", "user.email", "probe@example.invalid")
    git(str(nested), "config", "user.name", "probe")
    write(str(nested), "own.txt", "tracked inside another repository\n")
    commit(str(nested), "the nested head")
    return root, target


def scenario_repository_in_the_way() -> None:
    print("== a nested repository sits where the target wants a file ==")
    watched = ["y", "y/own.txt"]
    for label, build in MOVES:
        root, target = repo_in_the_way_repo()
        print(
            f"    before: y = {fingerprint(root, 'y')}, "
            f"y/own.txt = {fingerprint(root, 'y/own.txt')}"
        )
        ask(root, label.replace("<target>", target[:8]), build(target), watched)


def scenario_aftermath() -> None:
    print("== after both steps, what still keeps the tree from being clean ==")
    root, _, target = protected_repo()
    print(f"  HEAD={head(root)}; the restore goes back to {target[:8]}")
    listing(root, "status -uall before", ["status", "--porcelain", "-uall"])
    ask(root, "git reset --hard <target>", ["reset", "--hard", target], ["gone.txt", "tracked.txt", "plain.txt"])
    ask(
        root,
        "git clean -fd -- plain.txt gone.txt ign secret.txt",
        ["clean", "-fd", "--", "plain.txt", "gone.txt", "ign", "secret.txt"],
        ["plain.txt", "gone.txt", "ign", "secret.txt", "nested", "mod"],
    )
    rc, out, _ = git(root, "status", "--porcelain", "-uall")
    print(f"  tracked and untracked both gone? `status -uall` rc={rc} empty={not out}")
    if out:
        print(f"    what is left: {one_line(out)}")
    rc, out, _ = git(root, "diff", "--quiet", target)
    print(f"  the working tree matches the target tree? `diff --quiet <target>` rc={rc}")
    rc, out, _ = git(root, "status", "--porcelain", "-uall", "--ignored")
    print(f"  what the ignore rules and the boundaries still keep: {one_line(out)}")
    rc, out, _ = git(root, "ls-files", "--stage", "--", "mod")
    print(f"  the submodule is a gitlink in the index: {one_line(out)}")
    print(f"  `clean -fd` on a path that is a nested repository: rc="
          f"{git(root, 'clean', '-fd', '--', 'nested')[0]} {one_line(git(root, 'clean', '-fd', '--', 'nested')[1])}; "
          f"still there = {fingerprint(root, 'nested')}")


def measure_cost() -> None:
    print("== cost of the reads a preview is built from ==")
    root = scratch("large")
    count = 2000
    for index in range(count):
        write(root, f"src/pkg{index % 40}/file{index}.txt", f"body {index}\n")
    write(root, ".gitignore", "node_modules/\n")
    start = commit(root, "a wide tree")
    for index in range(count // 10):
        write(root, f"src/pkg{index % 40}/file{index}.txt", f"changed {index}\n")
    target = commit(root, "one tenth of it different")
    git(root, "checkout", "-q", start)
    for index in range(count // 20):
        write(root, f"extra/obstruct{index}.txt", "untracked in the way\n")
    write(root, "node_modules/pkg/index.js", "ignored bulk\n")
    print(f"  {count} tracked files, {count // 10} differing in the target, {count // 20} untracked")

    def timed(label: str, args: list[str]) -> None:
        began = time.perf_counter()
        rc, out, _ = git(root, *args)
        lines = len([piece for piece in out.split("\0") if piece]) if "-z" in args else len([line for line in out.splitlines() if line])
        print(f"    {label:46} rc={rc} {lines:5} entry(ies) {(time.perf_counter() - began) * 1000:7.1f} ms")

    timed("rev-parse HEAD", ["rev-parse", "HEAD"])
    timed("diff --name-only HEAD <target>", ["diff", "--name-only", "HEAD", target])
    timed("diff --name-status HEAD <target>", ["diff", "--name-status", "HEAD", target])
    timed("diff --name-status -z --no-renames HEAD <target>",
         ["diff", "--name-status", "-z", "--no-renames", "HEAD", target])
    timed("ls-tree -r -z --name-only <target>", ["ls-tree", "-r", "-z", "--name-only", target])
    timed("status --porcelain -z -uall", ["status", "--porcelain", "-z", "-uall"])
    timed("status --porcelain -z -uall --ignored", ["status", "--porcelain", "-z", "-uall", "--ignored"])
    timed("ls-files --others --exclude-standard -z", ["ls-files", "--others", "--exclude-standard", "-z"])
    timed("ls-files --others --ignored --exclude-standard -z",
          ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
    timed("clean -nd", ["clean", "-nd"])
    timed("clean -ndx", ["clean", "-ndx"])


def main() -> int:
    if shutil.which("git") is None:
        print("git is not on PATH", file=sys.stderr)
        return 2
    version = git(".", "--version")[1]
    print(f"{version}; every answer below is Git's own, and nothing here is asserted")
    print(f"scratch repositories are created under {tempfile.gettempdir()}\n")
    try:
        for scenario in (
            scenario_obstruction,
            scenario_type_change,
            scenario_prediction,
            scenario_folded_directory,
            scenario_repository_in_the_way,
            scenario_protected,
            scenario_aftermath,
            measure_cost,
        ):
            scenario()
            print()
    finally:
        for root in CREATED:
            # A nested repository and a submodule are read-only-ish trees of their own;
            # a removal that fails is not worth a crash, so the answer is still printed.
            shutil.rmtree(root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
