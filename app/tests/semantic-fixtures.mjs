// Phase-A semantic fixtures: reproducible Git-level ground truths that the
// renovation's new behaviours must match, each built and destroyed inside
// disposable temporary repositories. These lock down the meaning of "latest
// modification", reference-only change, wide topologies and the paths a
// clean reset must account for — the current implementation's known gaps are
// reproduced here as facts about Git, not as assertions about guit.

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EPOCH,
  cloneRepo,
  commitAll,
  createRepo,
  destroyRepo,
  git,
  graphOf,
  head,
  maxMtime,
  peakLanes,
  plumbingCommit,
  porcelainStatus,
  setRef,
  tryGit,
  writeFile,
} from "./helpers/semantic.mjs";

const scratchDirectories = [];
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), "guit-sem-scratch-"));
  scratchDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (scratchDirectories.length > 0) {
    rmSync(scratchDirectories.pop(), { recursive: true, force: true });
  }
});

test("latest modification is the maximum mtime over eligible files, never the dirty list", () => {
  const repo = createRepo();
  try {
    writeFile(repo, "a.txt", "a\n", EPOCH);
    writeFile(repo, "b.txt", "b\n", EPOCH + 300);
    writeFile(repo, "c.txt", "c\n", EPOCH + 60);
    commitAll(repo, "baseline");

    assert.equal(maxMtime(repo, ["a.txt", "b.txt", "c.txt"]), EPOCH + 300);
    assert.deepEqual(porcelainStatus(repo), [], "clean tree must still have a latest modification");

    // The current change list is not a candidate set: it is empty here.
    assert.equal(porcelainStatus(repo).length, 0);

    rmSync(join(repo, "b.txt"));
    assert.equal(
      maxMtime(repo, ["a.txt", "b.txt", "c.txt"]),
      EPOCH + 60,
      "the maximum must recompute over existing candidates",
    );
  } finally {
    destroyRepo(repo);
  }
});

test("a rewrite that preserves mtime does not move the latest modification", () => {
  const repo = createRepo();
  try {
    writeFile(repo, "a.txt", "a\n", EPOCH);
    commitAll(repo, "baseline");
    writeFile(repo, "a.txt", "changed content\n", EPOCH);
    assert.equal(maxMtime(repo, ["a.txt"]), EPOCH);
    assert.deepEqual(porcelainStatus(repo), [" M a.txt"], "Git sees the content change");
  } finally {
    destroyRepo(repo);
  }
});

test("staged-only and ignored states keep their candidates measurable", () => {
  const repo = createRepo();
  try {
    writeFile(repo, "a.txt", "a\n", EPOCH);
    commitAll(repo, "baseline");
    writeFile(repo, "a.txt", "staged change\n", EPOCH + 40);
    git(repo, ["add", "a.txt"]);
    const codes = porcelainStatus(repo).map((line) => line.slice(0, 2));
    assert.deepEqual(codes, ["M "], "staged-only is invisible to an unstaged-only reading");
    assert.equal(maxMtime(repo, ["a.txt"]), EPOCH + 40);

    writeFile(repo, ".gitignore", "build/\n", EPOCH + 10);
    commitAll(repo, "gitignore");
    assert.deepEqual(porcelainStatus(repo), [], "an ignored directory is invisible to status");
    writeFile(repo, "build/artifact.o", "x\n", EPOCH + 500);
    assert.equal(maxMtime(repo, [".gitignore", "a.txt", "build/artifact.o"]), EPOCH + 500);
  } finally {
    destroyRepo(repo);
  }
});

test("age is a bounded difference and future stamps never read as negative", () => {
  const repo = createRepo();
  try {
    writeFile(repo, "clock.txt", "future\n", EPOCH + 3600);
    const now = EPOCH;
    const delta = Math.max(0, now - maxMtime(repo, ["clock.txt"]));
    assert.equal(delta, 0, "a future mtime clamps to now, never a negative age");
  } finally {
    destroyRepo(repo);
  }
});

test("continuous writes advance the maximum monotonically, one step per write", () => {
  const repo = createRepo();
  try {
    writeFile(repo, "seed.txt", "seed\n", EPOCH);
    commitAll(repo, "baseline");
    let newest = maxMtime(repo, ["seed.txt"]);
    let advances = 0;
    for (let i = 0; i < 120; i += 1) {
      const when = EPOCH + 1000 + i;
      writeFile(repo, `stream/${String(i).padStart(3, "0")}.txt`, `write ${i}\n`, when);
      const candidates = ["seed.txt", ...Array.from({ length: i + 1 }, (_, k) => `stream/${String(k).padStart(3, "0")}.txt`)];
      const after = maxMtime(repo, candidates);
      assert.ok(after > newest, "every write with a newer stamp moves the latest modification");
      newest = after;
      advances += 1;
    }
    assert.equal(advances, 120);
    assert.equal(newest, EPOCH + 1119);
  } finally {
    destroyRepo(repo);
  }
});

test("two repositories with the same HEAD are indistinguishable by refs alone", () => {
  const source = createRepo();
  try {
    writeFile(source, "f.txt", "content\n");
    commitAll(source, "shared commit");
    const clone = cloneRepo(source, scratch());
    const sourceHead = head(source);
    assert.equal(head(clone), sourceHead);
    assert.equal(
      git(clone, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
      git(source, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
      "branch name matches too, so HEAD-based identity cannot separate sessions",
    );
  } finally {
    destroyRepo(source);
  }
});

test("a tag move changes no commit and no HEAD", () => {
  const repo = createRepo();
  try {
    writeFile(repo, "f.txt", "one\n");
    const first = commitAll(repo, "first");
    writeFile(repo, "f.txt", "two\n");
    const second = commitAll(repo, "second");
    setRef(repo, "refs/tags/v1", first);
    const before = head(repo);
    setRef(repo, "refs/tags/v1", second);
    assert.equal(head(repo), before, "HEAD is untouched by reference movement");
    const annotated = git(
      repo,
      ["tag", "-a", "v2", second, "-m", "release"],
      {
        env: {
          GIT_AUTHOR_NAME: "guit fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        },
      },
    );
    assert.equal(annotated, "");
    assert.match(git(repo, ["rev-list", "-n", "1", "v2^{}"]).trim(), /^[0-9a-f]{40}$/, "peeled tag resolves to a commit");
    assert.ok(git(repo, ["show-ref", "--tags"]).includes("refs/tags/v1"));
  } finally {
    destroyRepo(repo);
  }
});

test("an unborn branch has no HEAD to key history on", () => {
  const repo = createRepo();
  try {
    git(repo, ["checkout", "--quiet", "-b", "future"]);
    assert.equal(head(repo), null);
    assert.equal(tryGit(repo, ["rev-parse", "--verify", "HEAD"]).status !== 0, true);
  } finally {
    destroyRepo(repo);
  }
});

test("a deep single-parent history stays fully walkable", () => {
  const repo = createRepo();
  try {
    let previous = null;
    for (let i = 0; i < 400; i += 1) {
      const commit = plumbingCommit(repo, {
        path: "deep.txt",
        content: `line ${i}\n`,
        baseTree: previous === null ? null : previous.tree,
        parents: previous === null ? [] : [previous.oid],
        message: `deep ${i}`,
        when: EPOCH + i,
      });
      previous = commit;
    }
    setRef(repo, "refs/heads/main", previous.oid);
    git(repo, ["checkout", "--quiet", "main"]);
    assert.equal(Number(git(repo, ["rev-list", "--count", "HEAD"]).trim()), 400);
  } finally {
    destroyRepo(repo);
  }
});

test("a wide fan-out exceeds the current 24-lane simplification bound", () => {
  const repo = createRepo();
  try {
    const base = plumbingCommit(repo, { path: "base.txt", content: "base\n", message: "base", when: EPOCH });
    let when = EPOCH + 10;
    const tips = [];
    const trees = [];
    for (let b = 0; b < 26; b += 1) {
      let parent = base;
      for (let c = 0; c < 3; c += 1) {
        when += 1;
        parent = plumbingCommit(repo, {
          path: `f${b}-${c}.txt`,
          content: `branch ${b} commit ${c}\n`,
          baseTree: parent.tree,
          parents: [parent.oid],
          message: `b${b}c${c}`,
          when,
        });
      }
      tips.push(parent.oid);
      trees.push(parent.tree);
    }
    when += 100;
    const merge = plumbingCommit(repo, {
      path: "merged.txt",
      content: "merge\n",
      mergeTrees: [base.tree, ...trees],
      parents: [base.oid, ...tips],
      message: "many-way merge",
      when,
    });
    setRef(repo, "refs/heads/main", merge.oid);
    git(repo, ["checkout", "--quiet", "main"]);
    const graph = graphOf(repo);
    assert.equal(graph.length, 1 + 26 * 3 + 1);
    assert.ok(peakLanes(graph) >= 25, `expected a peak above the 24 bound, got ${peakLanes(graph)}`);
  } finally {
    destroyRepo(repo);
  }
});

test("an octopus merge carries three parents", () => {
  const repo = createRepo();
  try {
    const base = plumbingCommit(repo, { path: "base.txt", content: "base\n", message: "base", when: EPOCH });
    const branches = [];
    for (let b = 0; b < 3; b += 1) {
      branches.push(plumbingCommit(repo, {
        path: `side-${b}.txt`,
        content: `side ${b}\n`,
        baseTree: base.tree,
        parents: [base.oid],
        message: `side ${b}`,
        when: EPOCH + 10 + b,
      }));
    }
    const octopus = plumbingCommit(repo, {
      path: "octopus.txt",
      content: "octopus\n",
      mergeTrees: [base.tree, ...branches.map((branch) => branch.tree)],
      parents: branches.map((branch) => branch.oid),
      message: "octopus",
      when: EPOCH + 100,
    });
    setRef(repo, "refs/heads/main", octopus.oid);
    git(repo, ["checkout", "--quiet", "main"]);
    const [root] = graphOf(repo).filter((commit) => commit.oid === octopus.oid);
    assert.equal(root.parents.length, 3);
  } finally {
    destroyRepo(repo);
  }
});

test("a clean working tree hides the paths a reset to another commit must account for", () => {
  const repo = createRepo();
  try {
    writeFile(repo, "keep.txt", "keep\n", EPOCH);
    writeFile(repo, "quiet.txt", "quiet at HEAD\n", EPOCH);
    writeFile(repo, "twist.txt", "twist at HEAD\n", EPOCH);
    commitAll(repo, "HEAD state");
    git(repo, ["checkout", "--quiet", "-b", "target"]);
    writeFile(repo, "quiet.txt", "quiet at target\n");
    writeFile(repo, "twist.txt", "twist at target\n");
    commitAll(repo, "target state");
    git(repo, ["checkout", "--quiet", "main"]);

    assert.deepEqual(porcelainStatus(repo), [], "the observed dirty set is empty");
    const targetAhead = git(repo, ["rev-list", "--count", "main..target"]);
    assert.equal(targetAhead.trim(), "1");
    const changed = git(repo, ["diff", "--name-only", "main", "target"]).split("\n").filter(Boolean);
    assert.deepEqual(changed.sort(), ["quiet.txt", "twist.txt"], "the target tree differs on clean files");
  } finally {
    destroyRepo(repo);
  }
});

test("checkout refuses any untracked file in the way, even byte-identical content", () => {
  const blocking = createRepo();
  try {
    writeFile(blocking, "keep.txt", "keep\n", EPOCH);
    writeFile(blocking, "tracked.txt", "shared\n", EPOCH);
    commitAll(blocking, "base");
    git(blocking, ["checkout", "--quiet", "-b", "target"]);
    rmSync(join(blocking, "tracked.txt"));
    writeFile(blocking, "incoming.txt", "new target content\n");
    commitAll(blocking, "target");
    git(blocking, ["checkout", "--quiet", "main"]);
    writeFile(blocking, "incoming.txt", "untracked user data\n", EPOCH + 999);

    const result = tryGit(blocking, ["checkout", "target"]);
    assert.notEqual(result.status, 0, "Git refuses to overwrite the blocking untracked file");
    assert.equal(
      git(blocking, ["show", "target:incoming.txt"]),
      "new target content\n",
      "the target version exists and differs, which is exactly the blocked case",
    );
    assert.equal(
      porcelainStatus(blocking).filter((line) => line.startsWith("??")).length,
      1,
      "the blocker is visible only as untracked, not as a tracked change",
    );

    writeFile(blocking, "incoming.txt", "new target content\n", EPOCH + 999);
    const same = tryGit(blocking, ["checkout", "target"]);
    assert.notEqual(
      same.status,
      0,
      "Git compares existence, not bytes: even identical untracked content is refused",
    );
    assert.ok(same.stderr.includes("incoming.txt"), "the refusal names the obstructing path");
    assert.equal(git(blocking, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main", "the refusal leaves HEAD alone");
    assert.equal(readFileSync(join(blocking, "incoming.txt"), "utf8"), "new target content\n", "the preserved file is untouched by the refusal");
  } finally {
    destroyRepo(blocking);
  }

  const typeShift = createRepo();
  try {
    writeFile(typeShift, "seed.txt", "seed\n", EPOCH);
    commitAll(typeShift, "base");
    git(typeShift, ["checkout", "--quiet", "-b", "target"]);
    rmSync(join(typeShift, "seed.txt"));
    writeFile(typeShift, "seed.txt/nested.txt", "nested\n");
    commitAll(typeShift, "seed becomes a directory");
    git(typeShift, ["checkout", "--quiet", "main"]);

    const moved = tryGit(typeShift, ["checkout", "target"]);
    assert.equal(
      moved.status,
      0,
      "a clean tracked file yields to a target directory without protest: " + moved.stderr,
    );
    assert.equal(existsIn(typeShift, "seed.txt/nested.txt"), true, "the target directory is created");
    assert.deepEqual(
      porcelainStatus(typeShift),
      [],
      "a successful checkout lands exactly on the target tree",
    );
  } finally {
    destroyRepo(typeShift);
  }
});

test("clean honours pathspecs and spares ignored files without -ff", () => {
  const repo = createRepo();
  try {
    writeFile(repo, "seed.txt", "seed\n", EPOCH);
    writeFile(repo, ".gitignore", "ignored/\n", EPOCH);
    commitAll(repo, "base");
    writeFile(repo, "zone/a.txt", "untracked in zone\n", EPOCH + 1);
    writeFile(repo, "zone/b.txt", "untracked in zone\n", EPOCH + 2);
    writeFile(repo, "elsewhere.txt", "untracked outside\n", EPOCH + 3);
    writeFile(repo, "ignored/keep.o", "precious\n", EPOCH + 4);

    git(repo, ["clean", "-fd", "zone"]);
    assert.equal(existsIn(repo, "zone/a.txt"), false);
    assert.equal(existsIn(repo, "zone/b.txt"), false);
    assert.equal(existsIn(repo, "elsewhere.txt"), true, "pathspec-bounded clean leaves other paths");
    assert.equal(existsIn(repo, "ignored/keep.o"), true, "ignored files survive plain clean");

    const plainDryRun = git(repo, ["clean", "-nd"]);
    assert.ok(!plainDryRun.includes("ignored/"), "ignored paths are not even untracked candidates");
    const withX = git(repo, ["clean", "-ndx"]);
    assert.ok(withX.includes("ignored/"), "-x reaches the ignored directory");
    git(repo, ["clean", "-fdx"]);
    assert.equal(existsIn(repo, "ignored/keep.o"), false, "-fdx deletes the protected file");
  } finally {
    destroyRepo(repo);
  }
});

function existsIn(repo, path) {
  try {
    statSync(join(repo, path));
    return true;
  } catch {
    return false;
  }
}
