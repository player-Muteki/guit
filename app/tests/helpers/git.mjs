import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createGitFixture() {
  const directory = mkdtempSync(join(tmpdir(), "guit-test-"));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const runGit = (args, overrides = {}) => spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...environment,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(directory, "isolated-global-config"),
      GIT_TERMINAL_PROMPT: "0",
      XDG_CONFIG_HOME: directory,
      GIT_AUTHOR_NAME: "guit test",
      GIT_AUTHOR_EMAIL: "guit-test@example.invalid",
      GIT_COMMITTER_NAME: "guit test",
      GIT_COMMITTER_EMAIL: "guit-test@example.invalid",
      ...overrides,
    },
  });
  return {
    directory,
    runGit,
    git: (...args) => {
      const result = runGit(args);
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
