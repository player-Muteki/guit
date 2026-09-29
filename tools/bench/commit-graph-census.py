#!/usr/bin/env python3
"""Measure whether the commit-graph file that bounds a history read exists in
practice, and what one topology read costs at a real repository's size.

Why this exists: a page of history pays two whole-history walks (§6.2 of the
graph contract), and that price was measured in a synthetic 210,000-commit
fixture. Git has a cheaper answer when the repository carries a commit-graph
file — generation numbers instead of the walk — so the fixture's cost is only
the normal cost if real repositories do not have one. Nothing about the
panel's own reads is touched here: the census is a directory listing plus
`rev-list`, and the timing runs against a copy.

    python3 tools/bench/commit-graph-census.py                 # census
    python3 tools/bench/commit-graph-census.py --time ROOT     # time a copy
"""

import argparse
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

GRAPH_PATHS = ("objects/info/commit-graph",)


def run(args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)


def git(root, *args):
    return run(["git", "-C", root, *args])


def find_repos(top, max_depth):
    """Directories holding a `.git`, at most `max_depth` below `top`."""
    top = os.path.abspath(top)
    base_depth = top.rstrip(os.sep).count(os.sep)
    found = []
    for dirpath, dirnames, _ in os.walk(top):
        if not dirpath.startswith(top + os.sep):
            continue
        if dirpath.count(os.sep) - base_depth >= max_depth:
            dirnames[:] = []
            continue
        if ".git" in dirnames:
            found.append(dirpath)
            dirnames.remove(".git")
    return sorted(found)


def pack_count(git_dir):
    packs = os.path.join(git_dir, "objects", "pack")
    try:
        return sum(1 for name in os.listdir(packs) if name.endswith(".pack"))
    except OSError:
        return 0


def has_commit_graph(git_dir):
    for relative in GRAPH_PATHS:
        if os.path.exists(os.path.join(git_dir, relative)):
            return True
    packs = os.path.join(git_dir, "objects", "pack")
    try:
        return any(name.endswith(".graph") for name in os.listdir(packs))
    except OSError:
        return False


def census(roots, max_depth):
    rows = []
    for top in roots:
        for repo in find_repos(top, max_depth):
            git_dir = os.path.join(repo, ".git")
            if not os.path.isdir(git_dir):
                # A worktree or submodule whose git dir lives elsewhere: the
                # census reads files, and this one has none at this path.
                continue
            count = git(repo, "rev-list", "--count", "HEAD")
            config = git(repo, "config", "--get", "core.commitGraph")
            rows.append(
                {
                    "repo": repo,
                    "commits": int(count.stdout.strip()) if count.returncode == 0 else None,
                    "shallow": os.path.exists(os.path.join(git_dir, "shallow")),
                    "graph": has_commit_graph(git_dir),
                    "packs": pack_count(git_dir),
                    "core_commit_graph": config.stdout.strip() or "unset",
                }
            )
    print(f"{'graph':6} {'shallow':8} {'commits':>9} {'packs':>6}  core.commitGraph  repo")
    for row in rows:
        commits = "-" if row["commits"] is None else str(row["commits"])
        print(
            f"{'yes' if row['graph'] else 'no':6} "
            f"{'shallow' if row['shallow'] else 'full':8} "
            f"{commits:>9} {row['packs']:>6}  {row['core_commit_graph']:<17} {row['repo']}"
        )
    total = len(rows)
    graphs = sum(1 for row in rows if row["graph"])
    shallow = sum(1 for row in rows if row["shallow"])
    uncounted = sum(1 for row in rows if row["commits"] is None)
    print(
        f"\n{total} repositories, {graphs} with a commit-graph, {shallow} shallow"
        f"{' , ' + str(uncounted) + ' with no reachable HEAD' if uncounted else ''}"
    )
    return rows


def timed(root, argv, repeats):
    samples = []
    for _ in range(repeats):
        begin = time.monotonic()
        result = git(root, *argv)
        samples.append((time.monotonic() - begin) * 1000.0)
        if result.returncode != 0:
            return None, result.stderr.strip().splitlines()
    return statistics.median(samples), None


def read_costs(copy, head, total):
    """The three numbers that show what `--topo-order` charges a page: the
    ordered page, the same page unordered, and the whole history ordered (which
    is what `-n` fails to bound)."""
    return (
        (["log", "--no-color", "--topo-order", "--format=%H %P", "-n", "51", head, "--"], "one page, ordered"),
        (["log", "--no-color", "--format=%H %P", "-n", "51", head, "--"], "one page, unordered"),
        (
            ["log", "--no-color", "--topo-order", "--format=%H %P", "-n", str(total + 1), head, "--"],
            "the whole history, ordered",
        ),
    )


def report(copy, head, total, label):
    for argv, note in read_costs(copy, head, total):
        median, error = timed(copy, argv, repeats=7)
        if median is None:
            print(f"  {note}: failed: {error}")
            continue
        print(f"  {note} [{label} a commit-graph]: {median:.1f} ms")


def measure(repo):
    """Time the app's own topology read at a real repository's size, in a copy.

    The copy is measured twice: as it is, and again after asking Git to write a
    commit-graph into it. A shallow clone is where the second measurement never
    happens — Git writes no graph for one — and that is the fact this harness is
    here to establish, not a failure of it.
    """
    work = tempfile.mkdtemp(prefix="guit-graph-census-")
    copy = os.path.join(work, "repo")
    shutil.copytree(repo, copy, symlinks=True)
    git(copy, "config", "core.commitGraph", "true")
    reachable = git(copy, "rev-list", "--count", "HEAD")
    total = int(reachable.stdout.strip()) if reachable.returncode == 0 else 0
    head = git(copy, "rev-parse", "HEAD").stdout.strip()
    shallow = os.path.exists(os.path.join(copy, ".git", "shallow"))
    print(
        f"copy of {repo}: {total} reachable commits, "
        f"{pack_count(os.path.join(copy, '.git'))} packs, shallow: {shallow}"
    )
    report(copy, head, total, "without")
    write = git(copy, "commit-graph", "write", "--reachable")
    wrote = has_commit_graph(os.path.join(copy, ".git"))
    print(
        f"`git commit-graph write --reachable`: exit {write.returncode}, "
        f"a graph file exists afterwards: {wrote}"
        + (f", stderr: {write.stderr.strip()!r}" if write.stderr.strip() else "")
    )
    if wrote:
        report(copy, head, total, "with")
    shutil.rmtree(work, ignore_errors=True)


def control():
    """A repository this script creates, to show the control case: a graph
    written into a full clone is written, and read back."""
    work = tempfile.mkdtemp(prefix="guit-graph-control-")
    repo = os.path.join(work, "repo")
    os.mkdir(repo)
    git(repo, "init", "-q", ".")
    git(repo, "config", "user.email", "bench@example.invalid")
    git(repo, "config", "user.name", "bench")
    for index in range(3):
        with open(os.path.join(repo, "f"), "w", encoding="utf-8") as handle:
            handle.write(str(index))
        git(repo, "add", "f")
        git(repo, "commit", "-q", "-m", f"c{index}")
    write = git(repo, "commit-graph", "write", "--reachable")
    exists = os.path.exists(os.path.join(repo, ".git", "objects", "info", "commit-graph"))
    print(
        f"control (a fresh 3-commit clone): write exit {write.returncode}, "
        f"graph file exists: {exists}"
    )
    shutil.rmtree(work, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default="~/code", help="directory to census")
    parser.add_argument("--max-depth", type=int, default=3)
    parser.add_argument(
        "--time",
        metavar="REPO",
        help="copy REPO, try to write a commit-graph into the copy, time one page's reads",
    )
    args = parser.parse_args()
    top = os.path.expanduser(args.root)
    if not os.path.isdir(top):
        print(f"{top} is not a directory", file=sys.stderr)
        return 1
    census([top], max_depth=args.max_depth)
    control()
    if args.time:
        measure(os.path.abspath(os.path.expanduser(args.time)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
