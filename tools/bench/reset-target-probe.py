#!/usr/bin/env python3
"""What Git itself answers for a commit id a person typed.

Stage F resolves a restore target from free text, so the line between "a unique
abbreviation" and "not resolvable" is Git's rule rather than one we invent. Every
line this prints is Git's own exit status, stdout and stderr on a scratch repository
the script builds in a temporary directory and throws away; it never opens a
repository the panel has.

    python3 tools/bench/reset-target-probe.py

It asserts nothing on purpose: the answer depends on the installed Git, on how many
objects the repository holds and on the object format, so a run is read rather than
passed. The questions it exists to answer are how short a prefix Git still resolves
and what that floor is made of, what Git answers when one prefix names two commits,
what it answers when one prefix names a commit *and* a blob, whether a name that is
no object id at all still resolves, and what it does to the id of something that is
not a commit.

The colliding prefixes cannot be found by waiting: a 41-commit repository has no two
objects sharing four hex digits, and four is where Git stops resolving. So they are
searched for — a commit object and a blob whose id is brute-forced to start with a
chosen four hex — and written into the store. `hashlib` of the exact bytes Git would
store is the same id, so only the one hit needs a Git process to write it.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable


def run(args: list[str], cwd: str) -> tuple[int, str, str]:
    proc = subprocess.run(
        args,
        cwd=cwd,
        env={
            **os.environ,
            "LC_ALL": "C",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_AUTHOR_DATE": "2020-01-01T00:00:00+00:00",
            "GIT_COMMITTER_DATE": "2020-01-01T00:00:00+00:00",
        },
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def hash_stdin(repo: str, args: list[str], payload: bytes) -> tuple[int, str, str]:
    """One Git process, bytes on stdin, so a written object reports its own id."""
    proc = subprocess.run(
        ["git", *args],
        cwd=repo,
        env={**os.environ, "LC_ALL": "C"},
        input=payload,
        capture_output=True,
        check=False,
    )
    return (
        proc.returncode,
        proc.stdout.decode(errors="replace").strip(),
        proc.stderr.decode(errors="replace").strip(),
    )


def commit_body(tree: str, parent: str, message: str) -> bytes:
    """The payload of a commit object, field names included.

    `hash-object -t commit` fscks what it writes, and `author`/`committer` are part of
    the object text: a line carrying only the value is refused as missingAuthor.
    """
    identity = "probe <probe@example.invalid> 1577836800 +0000"
    return (
        f"tree {tree}\n"
        f"parent {parent}\n"
        f"author {identity}\n"
        f"committer {identity}\n"
        "\n"
        f"{message}"
    ).encode()


def search_for_payload(
    algorithm: str,
    prefix: str,
    kind: str,
    make: Callable[[int], bytes],
    limit: int = 8_000_000,
) -> bytes | None:
    """Bytes that, stored as `kind`, get an id starting with `prefix`.

    `hash-object` adds the `<type> <len> NUL` header itself, so the search hashes the
    whole object but hands only the payload to the write. Getting that backwards is how
    a searched-for prefix silently writes a different id.
    """
    hasher = getattr(hashlib, algorithm)
    head = f"{kind} ".encode()
    for index in range(limit):
        payload = make(index)
        digest = hasher(head + str(len(payload)).encode() + b"\0" + payload).hexdigest()
        if digest.startswith(prefix):
            return payload
    return None


def build(root: str, name: str, algorithm: str | None) -> tuple[str, str, int] | None:
    repo = os.path.join(root, name)
    os.mkdir(repo)
    init = ["git", "init", "-q", "-b", "main"]
    if algorithm is not None:
        init.append(f"--object-format={algorithm}")
    code, _, err = run(init, repo)
    if code != 0:
        print(f"\n=== object format: {algorithm} ===")
        print(f"  this Git refused to create one: {err[:120]}")
        return None
    run(["git", "config", "user.email", "probe@example.invalid"], repo)
    run(["git", "config", "user.name", "probe"], repo)
    for index in range(41):
        with open(os.path.join(repo, f"f{index}.txt"), "w", encoding="utf-8") as handle:
            handle.write(f"{index}\n")
        run(["git", "add", f"f{index}.txt"], repo)
        run(["git", "commit", "-qm", f"c{index}"], repo)
    run(["git", "tag", "-a", "-m", "annotated", "v1", "HEAD~1"], repo)
    hex_len = len(run(["git", "rev-parse", "HEAD"], repo)[1])
    return repo, algorithm or "sha1", hex_len


def objects(repo: str) -> list[tuple[str, str]]:
    """Every object id in the store, paired with its type.

    `cat-file --filter=object-type=` is refused by the Git on this host, so the type is
    read out of `--batch-check` (`<oid> <type> <size>`) and selected here.
    """
    code, out, err = run(["git", "cat-file", "--batch-all-objects", "--batch-check"], repo)
    if code != 0:
        print(f"  cat-file refused: {err[:90]}")
        return []
    found = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[1] in ("commit", "tree", "blob", "tag"):
            found.append((parts[0], parts[1]))
    return found


def candidates_for(repo: str, spec: str, abbrev: str | None = None) -> list[str]:
    pre = ["git", "-c", f"core.abbrev={abbrev}"] if abbrev else ["git"]
    _, out, _ = run(pre + ["rev-parse", f"--disambiguate={spec}"], repo)
    return [line.split()[0] for line in out.splitlines() if line.split()]


def ask(repo: str, spec: str, label: str) -> None:
    v_code, v_out, v_err = run(["git", "rev-parse", "--verify", "--quiet", f"{spec}^{{commit}}"], repo)
    b_code, b_out, b_err = run(["git", "rev-parse", "--verify", "--quiet", spec], repo)
    found = candidates_for(repo, spec)
    print(f"  {label:40} {spec[:18]:18}")
    print(f"  {'':40} X^{{commit}}: rc={v_code} -> {v_out[:16] or '-'}{'  ' + v_err[:52] if v_err else ''}")
    print(f"  {'':40} X       : rc={b_code} -> {b_out[:16] or '-'}{'  ' + b_err[:52] if b_err else ''}")
    print(
        f"  {'':40} --disambiguate: candidates={len(found)}"
        f"{' ' + ', '.join(c[:8] for c in found) if found else ''}"
    )


def triage(repo: str, spec: str, label: str) -> None:
    """What a refusal can be told apart from, once the peel has already said no.

    `rev-parse --verify --quiet X^{commit}` answers "exactly one commit" with one rc, and
    answers "no commit", "not a commit" and "two commits" with the same rc. So a panel
    that wants three different sentences has to ask three more questions, and the
    questions it can ask are what this prints: the raw candidate listing, the listing
    combined with a type requirement, one batched type query, and one peel per
    candidate. Nothing is asserted; the cost column is the number of Git processes a
    rule written from this answer would spend on a rejected target.
    """
    peel_code, peel_out, _ = run(
        ["git", "rev-parse", "--verify", "--quiet", f"{spec}^{{commit}}"], repo
    )
    _, raw, _ = run(["git", "rev-parse", f"--disambiguate={spec}"], repo)
    combo_code, combo_out, combo_err = run(
        ["git", "rev-parse", f"--disambiguate={spec}", "--verify", "--quiet", f"{spec}^{{commit}}"], repo
    )
    found = [line.split()[0] for line in raw.splitlines() if line.split()]
    print(f"  {label:40} {spec[:18]:18}  peel rc={peel_code} -> {peel_out[:16] or '-'}")
    print(f"  {'':40} --disambiguate alone : {len(found)} line(s) {raw.replace(chr(10), ' | ')[:96] or '-'}")
    print(
        f"  {'':40} --disambiguate + peel: rc={combo_code} -> {combo_out.replace(chr(10), ' | ')[:80] or '-'}"
        f"{'  ' + combo_err[:60] if combo_err else ''}"
    )
    if found:
        batch_code, batch_out, batch_err = hash_stdin(
            repo, ["cat-file", "--batch-check"], ("\n".join(found) + "\n").encode()
        )
        shapes = [line.split()[1] if len(line.split()) > 1 else "-" for line in batch_out.splitlines()]
        print(
            f"  {'':40} one batch-check      : rc={batch_code} types={','.join(shapes) or '-'}"
            f"{'  ' + batch_err[:60] if batch_err else ''}"
        )
        hits = [
            oid
            for oid in found
            if run(["git", "rev-parse", "--verify", "--quiet", f"{oid}^{{commit}}"], repo)[0] == 0
        ]
        print(
            f"  {'':40} peel per candidate   : {len(found)} process(es), {len(hits)} commit(s)"
        )
    else:
        print(f"  {'':40} one batch-check      : no candidates to ask about")


def type_filter(repo: str, spec: str, label: str) -> None:
    """Whether `--type=commit` narrows the answer, so a triage needs no type query.

    The candidate listing prints every object that bears the prefix, commit or not, which
    leaves the count of *commits* to be asked somewhere else. `rev-parse` has a type
    requirement of its own, so this asks whether it filters the listing as well as the
    resolution — one process would then answer "how many commits" directly.
    """
    for pre in (
        ["--disambiguate=" + spec, "--type=commit"],
        ["--disambiguate=" + spec, "--disambiguate-prefix=verbatim", "--type=commit"],
        ["--disambiguate=" + spec, "--type=commit", "--type=tree"],
    ):
        code, out, err = run(["git", "rev-parse", *pre, spec], repo)
        lines = [line for line in out.splitlines() if line]
        print(
            f"  {'':40} {' '.join(a.split('=')[0] for a in pre):44}"
            f": rc={code} {len(lines)} line(s) {','.join(line[:6] for line in lines)[:60] or '-'}"
            f"{'  ' + err[:44] if err else ''}"
        )
    code, out, err = run(
        ["git", "rev-parse", "--type=commit", "--verify", "--quiet", spec], repo
    )
    print(
        f"  {'':40} {'--type=commit --verify --quiet':44}: rc={code} -> {out[:16] or '-'}"
        f"{'  ' + err[:44] if err else ''}"
    )


def unshared_commit(store: list[tuple[str, str]]) -> str:
    """A commit no other object shares eight hex digits with.

    The abbreviation-floor measurement has to be about the floor and nothing else, so it
    needs a commit that is provably unique at every width the sweep asks about.
    """
    for oid, kind in store:
        if kind == "commit" and sum(1 for other, _ in store if other[:8] == oid[:8]) == 1:
            return oid
    return store[-1][0]


def floor_sweep(repo: str, clean: str, label: str) -> None:
    """Whether each prefix length resolves, and how many candidates Git sees."""
    total = len(objects(repo))
    _, short, _ = run(["git", "rev-parse", "--short", "HEAD"], repo)
    row = []
    for width in range(2, 9):
        code, _, _ = run(["git", "rev-parse", "--verify", "--quiet", f"{clean[:width]}^{{commit}}"], repo)
        row.append(f"{width}:{'ok' if code == 0 else 'no'}/{len(candidates_for(repo, clean[:width]))}")
    print(f"  {label:26} objects={total:6} --short={len(short)}  width:resolves/candidates  {' '.join(row)}")


def configured_floor(repo: str, clean: str) -> None:
    print("  --- is the input floor the config value? ---")
    for value in ("3", "4", "6", "10", "40"):
        code, out, err = run(
            ["git", "-c", f"core.abbrev={value}", "rev-parse", "--verify", "--quiet", f"{clean[:4]}^{{commit}}"],
            repo,
        )
        found = candidates_for(repo, clean[:4], abbrev=value)
        print(f"    core.abbrev={value:3}: 4 hex rc={code} -> {out[:16] or '-'} candidates={len(found)}{'  ' + err[:44] if err else ''}")


def bulk_blobs(root: str, repo: str, count: int) -> None:
    """Write `count` distinct objects, in one Git process.

    The object count is what is said to move Git's abbreviation floor, so measuring that
    needs a big store, and it needs one cheaply: the payloads go in as files and a single
    `hash-object --stdin-paths` writes them all.
    """
    box = os.path.join(root, f"bulk{count}")
    os.mkdir(box)
    paths = []
    for index in range(count):
        path = os.path.join(box, f"b{index}")
        with open(path, "wb") as handle:
            handle.write(f"{index}\n".encode())
        paths.append(path)
    code, _, err = hash_stdin(repo, ["hash-object", "-w", "--stdin-paths"], "\n".join(paths).encode())
    if code != 0:
        print(f"    the bulk write was refused: {err[:80]}")
    shutil.rmtree(box, ignore_errors=True)


def collide_with(repo: str, algorithm: str, target_prefix: str, tree: str, parent: str) -> None:
    print(f"  --- engineered collisions on the prefix {target_prefix} ---")
    commit_payload = search_for_payload(
        algorithm, target_prefix, "commit", lambda i: commit_body(tree, parent, f"x{i}")
    )
    if commit_payload is None:
        print("    the commit search gave up; that pair is unmeasured")
    else:
        code, oid, err = hash_stdin(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], commit_payload)
        print(f"    wrote a second commit: rc={code} oid={oid[:16] or '-'}{'  ' + err[:52] if err else ''}")
    blob_payload = search_for_payload(algorithm, target_prefix, "blob", lambda i: f"probe-blob-{i}".encode())
    if blob_payload is None:
        print("    the blob search gave up; that pair is unmeasured")
    else:
        code, oid, err = hash_stdin(repo, ["hash-object", "-w", "--stdin"], blob_payload)
        print(f"    wrote a blob          : rc={code} oid={oid[:16] or '-'}{'  ' + err[:52] if err else ''}")


def probe_format(root: str, name: str, algorithm: str | None) -> bool:
    built = build(root, name, algorithm)
    if built is None:
        return False
    repo, format_name, hex_len = built
    print(f"\n=== object format: {format_name} (id width {hex_len}) ===")
    _, version, _ = run(["git", "--version"], repo)
    store = objects(repo)
    commits = [oid for oid, kind in store if kind == "commit"]
    print(f"  {version}; {len(commits)} commits, {len(store) - len(commits)} non-commits in the store")
    code, abbrev, _ = run(["git", "config", "--get", "core.abbrev"], repo)
    print(f"  core.abbrev: {'unset, so Git decides by object count' if code != 0 else abbrev}")

    clean = unshared_commit(store)
    print("  --- the floor for a prefix that names exactly one object ---")
    floor_sweep(repo, clean, "as built")
    configured_floor(repo, clean)
    bulk_blobs(root, repo, 40_000)
    floor_sweep(repo, clean, "after 40k more objects")

    print("  --- a name that is not an object id at all ---")
    for label, spec in [
        ("branch name", "main"),
        ("tag name", "v1"),
        ("revspec HEAD~1", "HEAD~1"),
        ("revspec HEAD^", "HEAD^"),
        ("upstream shorthand", "@{0}"),
        ("the literal HEAD", "HEAD"),
        ("working file path", "f1.txt"),
        ("looks like an option", "--help"),
        ("dash then hex", f"-{clean[:7]}"),
        ("leading space", f" {clean[:7]}"),
        ("trailing space", f"{clean[:7]} "),
        ("empty", ""),
        ("hex of the other width", "a" * (40 if hex_len == 64 else 64)),
        ("non-hex of full width", "z" * hex_len),
        ("upper case full id", clean.upper()),
    ]:
        ask(repo, spec, label)

    print("  --- the id of something that is not a commit ---")
    for kind in ("tree", "blob", "tag"):
        found = [oid for oid, seen in store if seen == kind]
        if found:
            ask(repo, found[0], f"full id of a {kind}")
    ask(repo, f"{clean[:7]}^{{tree}}", "hex plus an explicit peel")

    print("  --- one prefix, before and after it stops being unique ---")
    prefix4 = clean[:4]
    ask(repo, prefix4, "4 hex naming exactly one commit")
    ask(repo, clean, "its full id")
    tree = run(["git", "rev-parse", "HEAD^{tree}"], repo)[1]
    collide_with(repo, format_name, prefix4, tree, run(["git", "rev-parse", "HEAD~2"], repo)[1])
    store = objects(repo)
    print("    what the store holds under that prefix now:")
    for oid, kind in sorted(store):
        if oid.startswith(prefix4):
            print(f"      {oid}  {kind}")
    ask(repo, prefix4, "the same 4 hex, shared now")
    shared = sorted(oid for oid, kind in store if kind == "commit" and oid.startswith(prefix4))
    for width in (5, 6, 7, 8):
        if len(shared) >= 2:
            ask(repo, shared[1][:width], f"{width} hex, still two commits")
    ask(repo, clean, "the full id of one of them")

    print("  --- telling the refusals apart ---")
    triage(repo, prefix4, "the shared 4 hex")
    type_filter(repo, prefix4, "the shared 4 hex")
    triage(repo, prefix4[:3], "one hex shorter than that")
    for kind in ("tree", "blob", "tag"):
        found = [oid for oid, seen in store if seen == kind]
        if found:
            triage(repo, found[0], f"full id of a {kind}")
    blob = [oid for oid, seen in store if seen == "blob"]
    if blob:
        type_filter(repo, blob[0], "full id of a blob")
    triage(repo, "f" * hex_len, "a full-width id of nothing")
    type_filter(repo, "f" * hex_len, "a full-width id of nothing")
    triage(repo, "a" * (40 if hex_len == 64 else 64), "hex of the other width")
    triage(repo, clean.upper(), "the upper case full id")
    type_filter(repo, clean.upper(), "the upper case full id")
    return True


def main() -> int:
    if shutil.which("git") is None:
        print("git is not on PATH", file=sys.stderr)
        return 2
    root = tempfile.mkdtemp(prefix="guit-reset-target-")
    try:
        ran = probe_format(root, "sha1", None)
        second = probe_format(root, "sha256", "sha256")
        if ran and not second:
            print("\nthe second format could not be probed here, so its widths stay unmeasured")
        return 0 if ran else 1
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
