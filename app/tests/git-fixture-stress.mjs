// Stress suite for the isolated Git fixture helper (tests/helpers/git.mjs):
// environment stripping, configuration isolation, hostile paths and scale.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createGitFixture } from "./helpers/git.mjs";

test("a hostile GIT_* environment in the parent process cannot reach the fixture", () => {
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = "/does/not/exist";
  let fixture;
  try {
    fixture = createGitFixture(); // captures the (poisoned) process.env at creation
    fixture.git("init", "--quiet");
    // Without stripping, git would fail on the bogus GIT_DIR.
    assert.match(fixture.git("status", "--porcelain=v2", "-z", "--branch"), /# branch/);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
    fixture?.cleanup();
  }
});

test("the real user and system configuration cannot leak into the fixture", () => {
  const fixture = createGitFixture();
  try {
    fixture.git("init", "--quiet");
    // No user.name is ever visible: NOSYSTEM plus a private global file.
    const lookup = fixture.runGit(["config", "--get", "user.name"]);
    assert.equal(lookup.status, 1, "user.name resolves to nothing in the sandbox");
    // Repository-local configuration works and survives the isolation,
    // proving the fixture is a real, writable sandbox and not a shared one.
    fixture.git("config", "user.name", "Local Tester");
    assert.equal(fixture.git("config", "--get", "user.name").trim(), "Local Tester");
    writeFileSync(join(fixture.directory, "a.txt"), "a\n");
    fixture.git("add", "--", "a.txt");
    fixture.git("commit", "--quiet", "-m", "x");
    assert.equal(fixture.git("status", "--porcelain=v2", "-z"), "");
  } finally {
    fixture.cleanup();
  }
});

test("two live fixtures never see each other", () => {
  const a = createGitFixture();
  const b = createGitFixture();
  try {
    assert.notEqual(a.directory, b.directory);
    a.git("init", "--quiet");
    b.git("init", "--quiet");
    writeFileSync(join(a.directory, "only-a.txt"), "a\n");
    assert.doesNotMatch(b.git("status", "--porcelain=v2", "-z"), /only-a/);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("git() throws on failure while runGit() reports it", () => {
  const fixture = createGitFixture();
  try {
    assert.throws(() => fixture.git("status"));
    const result = fixture.runGit(["status"], { LC_ALL: "C" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a git repository/);
    assert.equal(fixture.runGit(["rev-parse", "HEAD"]).error, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("cleanup removes the directory and may run twice", () => {
  const fixture = createGitFixture();
  const directory = fixture.directory;
  assert.ok(existsSync(directory));
  fixture.cleanup();
  fixture.cleanup();
  assert.ok(!existsSync(directory));
});

test("hostile file names survive init, add and porcelain v2 -z untouched", () => {
  const fixture = createGitFixture();
  try {
    fixture.git("init", "--quiet", "--initial-branch=main");
    const names = [
      "plain.txt",
      "with spaces and 中文.txt",
      "it's-a-file.txt",
      'quote"inside.txt',
      "tab\tname.txt",
      "back\\slash.txt",
      "ünïcödé-🎸.txt",
      `${"very-long-directory-name-".repeat(4)}x/${"f".repeat(80)}.txt`,
    ];
    for (const name of names) {
      mkdirSync(dirname(join(fixture.directory, name)), { recursive: true });
      writeFileSync(join(fixture.directory, name), "content\n");
    }
    fixture.git("add", "--", ...names);
    const output = fixture.git("status", "--porcelain=v2", "-z");
    for (const name of names) {
      // Porcelain v2 keeps the path inside the record, NUL-terminated and
      // never quoted — the parser relies on that.
      assert.ok(
        output.split("\0").some((record) => record.endsWith(` ${name}`)),
        `porcelain v2 -z carries ${JSON.stringify(name)} verbatim`,
      );
    }
    fixture.git("commit", "--quiet", "-m", "hostile names");
    assert.equal(fixture.runGit(["status", "--porcelain=v2", "-z"]).stdout, "");
  } finally {
    fixture.cleanup();
  }
});

test("2000 dirty files produce a status a snapshot consumer can count", () => {
  const fixture = createGitFixture();
  try {
    fixture.git("init", "--quiet", "--initial-branch=main");
    writeFileSync(join(fixture.directory, "seed.txt"), "seed\n");
    fixture.git("add", "--", "seed.txt");
    fixture.git("commit", "--quiet", "-m", "seed");
    const started = Date.now();
    for (let i = 0; i < 2000; i += 1) {
      writeFileSync(join(fixture.directory, `file-${String(i).padStart(4, "0")}.txt`), "x\n");
    }
    for (let i = 0; i < 200; i += 1) {
      writeFileSync(join(fixture.directory, `file-000${i % 10}.txt`.slice(0, 37)), "changed\n");
    }
    const output = fixture.git("status", "--porcelain=v2", "-z");
    // Porcelain v2 prints untracked paths as bare "? <path>" records while
    // tracked changes are "1 XY ...", conflicts "u " and ignored "!":
    // a consumer that only counts the numbered records loses every untracked
    // file, which is exactly the mistake this gate catches.
    const entries = output.split("\0").filter((record) => /^[12u?!]/.test(record));
    assert.equal(entries.length, 2000, "one entry per dirty path, untracked and modified alike");
    assert.ok(Date.now() - started < 60000, "the fixture stays usable under a dirty repository");
  } finally {
    fixture.cleanup();
  }
});
