import assert from "node:assert/strict";
import test from "node:test";
import { createGitFixture } from "./helpers/git.mjs";

test("temporary Git fixture isolates configuration and can be removed", () => {
  const fixture = createGitFixture();
  try {
    fixture.git("init", "--quiet");
    const output = fixture.git("status", "--porcelain=v2", "-z", "--branch");
    assert.match(output, /# branch\.oid \(initial\)/);
  } finally {
    fixture.cleanup();
  }
});
