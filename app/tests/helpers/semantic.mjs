// Deterministic builders for the semantic scenarios the renovation must
// satisfy. Every scenario talks to a real `git` binary inside disposable
// temporary repositories — including the destructive ones, which never run
// against a developer's repo. mtimes are stamped explicitly rather than
// slept on, so a scenario reproduces identically under a drifting clock.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const EPOCH = 1_700_000_000;

const INHERITED_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

function baseEnv(directory) {
  return {
    ...INHERITED_ENV,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(directory, ".isolated-global-config"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "guit fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "guit fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
}

// Runs git without asserting success, for the refusal paths that are
// themselves the ground truth.
export function tryGit(directory, args, { env = {}, input = null } = {}) {
  return spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: { ...baseEnv(directory), ...env },
    input,
    timeout: 15000,
  });
}

export function git(directory, args, options = {}) {
  const result = tryGit(directory, args, options);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

export function createRepo() {
  const directory = mkdtempSync(join(tmpdir(), "guit-sem-fixture-"));
  git(directory, ["init", "--quiet", "--initial-branch=main"]);
  return directory;
}

export function destroyRepo(directory) {
  rmSync(directory, { recursive: true, force: true });
}

export function cloneRepo(sourceDir, workDir) {
  const result = tryGit(workDir, ["clone", "--quiet", sourceDir, join(workDir, "clone")]);
  assert.equal(result.status, 0, result.stderr);
  return join(workDir, "clone");
}

export function writeFile(repoDir, path, content, mtime = null) {
  const absolute = join(repoDir, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  if (mtime !== null) utimesSync(absolute, mtime, mtime);
  return absolute;
}

// The contract's "latest modification": the maximum mtime over existing
// working-tree candidate files — not the last watcher event, refresh or
// commit. Missing files are skipped, matching "eligible existing files".
export function maxMtime(repoDir, paths) {
  let newest = -1;
  for (const path of paths) {
    try {
      const seconds = statSync(join(repoDir, path)).mtimeMs / 1000;
      if (seconds > newest) newest = seconds;
    } catch {
      continue;
    }
  }
  return newest;
}

export function commitAll(repoDir, message) {
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", message]);
  return head(repoDir);
}

export function head(repoDir) {
  const result = tryGit(repoDir, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

// Commit-graph metadata for every reachable commit, used by the reference
// topology model below.
export function graphOf(repoDir, rev = "HEAD") {
  const out = git(repoDir, ["log", "--format=%H%x00%P%x00%at%x00%ct%x00", rev]);
  const commits = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [oid, parents, at, ct] = line.split("\0");
    commits.push({ oid, parents: parents ? parents.split(" ") : [], at: Number(at), ct: Number(ct) });
  }
  return commits;
}

// A commit in the object database whose tree accumulates `path` on top of a
// base tree — no worktree writes, so wide and deep topologies cost
// milliseconds rather than one checkout per commit. `mergeTrees` unions
// several trees (an octopus needs every side present). Returns { oid, tree }.
export function plumbingCommit(repoDir, { path, content, baseTree = null, parents = [], message, when = EPOCH, mergeTrees = [] }) {
  const scratch = mkdtempSync(join(repoDir, ".sem-scratch-"));
  try {
    const file = join(scratch, "blob");
    writeFileSync(file, content);
    const blob = git(repoDir, ["hash-object", "-w", file]).trim();
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    for (const tree of [baseTree, ...mergeTrees].filter((value) => value !== null)) {
      git(repoDir, ["read-tree", "-m", "-i", tree], { env });
    }
    git(repoDir, ["update-index", "--add", "--replace", "--cacheinfo", `100644,${blob},${path}`], { env });
    const tree = git(repoDir, ["write-tree"], { env }).trim();
    const stamp = `${when} +0000`;
    const args = ["commit-tree", tree];
    for (const parent of parents) args.push("-p", parent);
    args.push("-m", message);
    const oid = git(repoDir, args, {
      env: {
        GIT_AUTHOR_DATE: stamp,
        GIT_COMMITTER_DATE: stamp,
        GIT_AUTHOR_NAME: "guit fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "guit fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
    return { oid, tree };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function setRef(repoDir, ref, oid) {
  git(repoDir, ["update-ref", ref, oid]);
}

export function treeOf(repoDir, rev) {
  return git(repoDir, ["rev-parse", `${rev}^{tree}`]).trim();
}

export function porcelainStatus(repoDir) {
  return git(repoDir, ["status", "--porcelain=v1"]).split("\n").filter(Boolean);
}

// Reference lane model shared with the graph checks: the walk visits commits
// newest-first by (ct, at, oid); a new commit reuses the lowest retired
// lane, otherwise continues its first parent's lane, otherwise opens a new
// lane; a lane retires once the walk passes the commit it was following.
// The answer is the peak simultaneous lane count — the width a renderer
// must support before it may honestly degrade.
export function peakLanes(commits) {
  const keyOf = new Map(
    commits.map((commit) => [
      commit.oid,
      `${String(commit.ct).padStart(12, "0")}:${String(commit.at).padStart(12, "0")}:${commit.oid}`,
    ]),
  );
  const order = [...commits].sort((a, b) => (keyOf.get(b) < keyOf.get(a) ? -1 : 1));
  const laneOf = new Map();
  const exit = [];
  let lanes = 0;
  let peak = 0;
  for (const commit of order) {
    const free = [];
    for (let lane = 0; lane < lanes; lane += 1) {
      if (exit[lane] < keyOf.get(commit)) free.push(lane);
    }
    let lane = free[0];
    if (lane === undefined) {
      const firstParent = commit.parents[0];
      if (firstParent !== undefined && laneOf.has(firstParent)) {
        lane = laneOf.get(firstParent);
      } else {
        lane = lanes;
        lanes += 1;
      }
    }
    exit[lane] = keyOf.get(commit);
    laneOf.set(commit.oid, lane);
    peak = Math.max(peak, lanes);
  }
  return peak;
}
