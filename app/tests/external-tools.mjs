import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createGitFixture } from "./helpers/git.mjs";

function quoteForGitTool(value) {
  return `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
}

function prepare() {
  const fixture = createGitFixture();
  fixture.git("init", "--quiet", "--initial-branch=main");
  const filename = "file name 中文.txt";
  const path = join(fixture.directory, filename);
  writeFileSync(path, "base\n");
  fixture.git("add", "--", filename);
  fixture.git("commit", "--quiet", "-m", "base");
  const helper = fileURLToPath(new URL("./helpers/external-tool.cjs", import.meta.url));
  const command = `${quoteForGitTool(process.execPath)} ${quoteForGitTool(helper)}`;
  const record = join(fixture.directory, "tool-calls.jsonl");
  return { ...fixture, filename, path, command, record };
}

test("difftool receives paths, preserves changes, and reports tool failures", () => {
  const fixture = prepare();
  try {
    assert.equal(fixture.runGit(["config", "--get", "diff.tool"]).status, 1);
    fixture.git("config", "diff.tool", "guit-probe");
    fixture.git("config", "difftool.guit-probe.cmd", `${fixture.command} diff "$LOCAL" "$REMOTE"`);
    writeFileSync(fixture.path, "changed\n");
    const args = ["difftool", "--no-prompt", "--trust-exit-code", "--", fixture.filename];
    const environment = { GUIT_TOOL_RECORD: fixture.record };
    const result = fixture.runGit(args, environment);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(fixture.record, "utf8")), {
      mode: "diff", local: "base\n", remote: "changed\n",
    });
    assert.match(fixture.git("status", "--porcelain=v2", "-z"), /file name 中文\.txt\0/);
    const failed = fixture.runGit(args, { ...environment, GUIT_TOOL_EXIT: "7" });
    assert.ifError(failed.error);
    assert.notEqual(failed.status, 0);
    fixture.git("config", "difftool.guit-probe.cmd", "guit-nonexistent-tool");
    assert.notEqual(fixture.runGit(args).status, 0);
    assert.equal(readFileSync(fixture.path, "utf8"), "changed\n");
  } finally {
    fixture.cleanup();
  }
});

test("mergetool failure preserves conflict and success is checked through Git status", () => {
  const fixture = prepare();
  try {
    assert.equal(fixture.runGit(["config", "--get", "merge.tool"]).status, 1);
    fixture.git("checkout", "--quiet", "-b", "other");
    writeFileSync(fixture.path, "other\n");
    fixture.git("commit", "--quiet", "-am", "other");
    fixture.git("checkout", "--quiet", "main");
    writeFileSync(fixture.path, "main\n");
    fixture.git("commit", "--quiet", "-am", "main");
    assert.equal(fixture.runGit(["merge", "other"]).status, 1);
    fixture.git("config", "merge.tool", "guit-probe");
    fixture.git("config", "mergetool.guit-probe.cmd", `${fixture.command} merge "$LOCAL" "$REMOTE" "$MERGED"`);
    fixture.git("config", "mergetool.guit-probe.trustExitCode", "true");
    fixture.git("config", "mergetool.keepBackup", "false");
    const args = ["mergetool", "--no-prompt", "--", fixture.filename];
    const environment = { GUIT_TOOL_RECORD: fixture.record };
    const failed = fixture.runGit(args, { ...environment, GUIT_TOOL_EXIT: "7" });
    assert.ifError(failed.error);
    assert.notEqual(failed.status, 0);
    assert.match(fixture.git("status", "--porcelain=v2", "-z"), /^u /);
    const result = fixture.runGit(args, environment);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.git("ls-files", "--unmerged", "-z"), "");
    assert.equal(readFileSync(fixture.path, "utf8"), "other\n");
    assert.match(fixture.git("status", "--porcelain=v2", "-z"), /^1 M\./);
  } finally {
    fixture.cleanup();
  }
});
