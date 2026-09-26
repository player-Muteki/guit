// Stress suite for the external-tool contracts guit relies on: the exact
// meaning of exit codes with and without --trust-exit-code, repeated
// invocations, and hostile path characters. Runs in its own process
// alongside tests/external-tools.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createGitFixture } from "./helpers/git.mjs";

function quoteForGitTool(value) {
  return `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
}

function prepare(filename = "file name 中文.txt") {
  const fixture = createGitFixture();
  fixture.git("init", "--quiet", "--initial-branch=main");
  const path = join(fixture.directory, filename);
  writeFileSync(path, "base\n");
  fixture.git("add", "--", filename);
  fixture.git("commit", "--quiet", "-m", "base");
  const helper = fileURLToPath(new URL("./helpers/external-tool.cjs", import.meta.url));
  const command = `${quoteForGitTool(process.execPath)} ${quoteForGitTool(helper)}`;
  const record = join(fixture.directory, "tool-calls.jsonl");
  return { ...fixture, filename, path, command, record };
}

function configureDiff(fixture) {
  fixture.git("config", "diff.tool", "guit-probe");
  fixture.git("config", "difftool.guit-probe.cmd", `${fixture.command} diff "$LOCAL" "$REMOTE"`);
}

test("quoteForGitTool survives apostrophes, backslashes and spaces", () => {
  assert.equal(quoteForGitTool("/a b/c"), "'/a b/c'");
  assert.equal(quoteForGitTool("/it's/x"), "'/it'\\''s/x'");
  assert.equal(quoteForGitTool("C:\\x"), "'C:/x'");
  // Executing the quote form through sh must yield the original word back.
  for (const value of ["/tmp/it's a file 中文.txt", "/tmp/plain"]) {
    const r = spawnSync("sh", ["-c", `printf %s ${quoteForGitTool(value)}`], { encoding: "utf8" });
    assert.equal(r.stdout, value);
  }
});

test("--trust-exit-code is what makes a tool failure visible to guit", () => {
  const fixture = prepare();
  try {
    configureDiff(fixture);
    writeFileSync(fixture.path, "changed\n");
    const environment = { GUIT_TOOL_RECORD: fixture.record, GUIT_TOOL_EXIT: "7" };
    const trusted = fixture.runGit(
      ["difftool", "--no-prompt", "--trust-exit-code", "--", fixture.filename],
      environment,
    );
    assert.notEqual(trusted.status, 0, "with the flag, exit 7 reaches the caller");
    const untrusted = fixture.runGit(
      ["difftool", "--no-prompt", "--", fixture.filename],
      environment,
    );
    assert.equal(untrusted.status, 0, "without the flag, git hides the failure — so guit must always pass it");
  } finally {
    fixture.cleanup();
  }
});

test("one difftool over two paths invokes the tool once per path", () => {
  const fixture = prepare("one.txt");
  try {
    configureDiff(fixture);
    writeFileSync(join(fixture.directory, "two.txt"), "two base\n");
    fixture.git("add", "--", "two.txt");
    fixture.git("commit", "--quiet", "-m", "two");
    writeFileSync(fixture.path, "one changed\n");
    writeFileSync(join(fixture.directory, "two.txt"), "two changed\n");
    const result = fixture.runGit(
      ["difftool", "--no-prompt", "--trust-exit-code"],
      { GUIT_TOOL_RECORD: fixture.record },
    );
    assert.equal(result.status, 0, result.stderr);
    const invocations = readFileSync(fixture.record, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2, "both diffs ran");
    assert.deepEqual(invocations.map((call) => call.remote).sort(), ["one changed\n", "two changed\n"]);
  } finally {
    fixture.cleanup();
  }
});

test("paths carrying apostrophes and CJK round-trip through the difftool command line", () => {
  const fixture = prepare("it's 中文 'quoted'.txt");
  try {
    configureDiff(fixture);
    writeFileSync(fixture.path, "changed\n");
    const result = fixture.runGit(
      ["difftool", "--no-prompt", "--trust-exit-code", "--", fixture.filename],
      { GUIT_TOOL_RECORD: fixture.record },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(fixture.record, "utf8")), {
      mode: "diff", local: "base\n", remote: "changed\n",
    });
  } finally {
    fixture.cleanup();
  }
});

function makeConflict(fixture) {
  fixture.git("checkout", "--quiet", "-b", "other");
  writeFileSync(fixture.path, "other\n");
  fixture.git("commit", "--quiet", "-am", "other");
  fixture.git("checkout", "--quiet", "main");
  writeFileSync(fixture.path, "main\n");
  fixture.git("commit", "--quiet", "-am", "main");
  assert.equal(fixture.runGit(["merge", "other"]).status, 1);
}

// A tool that writes the resolution and then exits 7: git mergetool's verdict
// is decided by trustExitCode only in this shape — a failing tool that leaves
// the conflict in place always reports failure, whatever the flag says.
function failingButResolvingCmd(fixture) {
  fixture.git("config", "merge.tool", "guit-probe");
  fixture.git("config", "mergetool.guit-probe.cmd",
    `${fixture.command} merge "$LOCAL" "$REMOTE" "$MERGED"; rc=$?; cp "$REMOTE" "$MERGED"; exit $rc`);
  fixture.git("config", "mergetool.keepBackup", "false");
}

test("mergetool trustExitCode decides the verdict when the failing tool resolved anyway", () => {
  const untrusting = prepare();
  const trusting = prepare();
  try {
    makeConflict(untrusting);
    failingButResolvingCmd(untrusting);
    const lenient = untrusting.runGit(
      ["mergetool", "--no-prompt", "--", untrusting.filename],
      { GUIT_TOOL_RECORD: untrusting.record, GUIT_TOOL_EXIT: "7" },
    );
    assert.equal(lenient.status, 0, "without trustExitCode the resolution stands");
    assert.equal(untrusting.git("ls-files", "--unmerged", "-z"), "");

    makeConflict(trusting);
    failingButResolvingCmd(trusting);
    trusting.git("config", "mergetool.guit-probe.trustExitCode", "true");
    const strict = trusting.runGit(
      ["mergetool", "--no-prompt", "--", trusting.filename],
      { GUIT_TOOL_RECORD: trusting.record, GUIT_TOOL_EXIT: "7" },
    );
    assert.notEqual(strict.status, 0, "with trustExitCode the 7 reaches the caller");
    assert.match(trusting.git("status", "--porcelain=v2", "-z"), /^u /, "and the conflict is put back");
  } finally {
    untrusting.cleanup();
    trusting.cleanup();
  }
});

test("a failing tool that never resolves keeps the conflict regardless of the flag", () => {
  const fixture = prepare();
  try {
    makeConflict(fixture);
    failingButResolvingCmd(fixture);
    // No cp will run: make the command the plain probe, which exits before copying.
    fixture.git("config", "mergetool.guit-probe.cmd",
      `${fixture.command} merge "$LOCAL" "$REMOTE" "$MERGED"`);
    for (const trust of ["false", "true"]) {
      fixture.git("config", "mergetool.guit-probe.trustExitCode", trust);
      const result = fixture.runGit(
        ["mergetool", "--no-prompt", "--", fixture.filename],
        { GUIT_TOOL_RECORD: fixture.record, GUIT_TOOL_EXIT: "7" },
      );
      assert.notEqual(result.status, 0, `an unresolved conflict fails even with trustExitCode=${trust}`);
      assert.match(fixture.git("status", "--porcelain=v2", "-z"), /^u /, "conflict preserved");
    }
  } finally {
    fixture.cleanup();
  }
});

test("a deleted worktree file diffs the index copy against an empty version", () => {
  const fixture = prepare("deleted.txt");
  try {
    configureDiff(fixture);
    rmSync(fixture.path);
    const result = fixture.runGit(
      ["difftool", "--no-prompt", "--trust-exit-code", "--", fixture.filename],
      { GUIT_TOOL_RECORD: fixture.record },
    );
    assert.equal(result.status, 0, result.stderr);
    const call = JSON.parse(readFileSync(fixture.record, "utf8"));
    assert.equal(call.local, "base\n", "LOCAL carries the indexed content");
    assert.equal(call.remote, "", "REMOTE carries the deletion");
  } finally {
    fixture.cleanup();
  }
});
