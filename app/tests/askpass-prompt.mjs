import assert from "node:assert/strict";
import test from "node:test";
import { promptText, replacesPrompt } from "../src/dialogs/askpassPrompt.ts";

const request = (overrides = {}) => ({
  operationId: 7,
  kind: "password",
  target: "https://github.com/owner/repo",
  user: "octocat",
  ...overrides,
});

test("a prompt names the target and the account it is asking about", () => {
  assert.equal(
    promptText(request(), false),
    "Password for https://github.com/owner/repo as octocat:",
  );
  assert.equal(
    promptText(request({ user: null }), false),
    "Password for https://github.com/owner/repo:",
  );
  assert.equal(
    promptText(request({ kind: "username", user: null }), false),
    "Username for https://github.com/owner/repo:",
  );
});

test("a prompt that replaced another one says so", () => {
  assert.match(promptText(request(), true), /replaced another/);
  assert.match(promptText(request(), true), /discarded/);
});

test("replacement is a property of the two questions, not of the arrival", () => {
  assert.equal(replacesPrompt(null, request()), false, "the first prompt replaces nothing");
  assert.equal(replacesPrompt(request(), request()), false, "the same question re-asked");
  assert.equal(replacesPrompt(request(), request({ kind: "username" })), true);
  assert.equal(replacesPrompt(request(), request({ target: "https://gitlab.com/owner/repo" })), true);
  assert.equal(replacesPrompt(request(), request({ operationId: 8 })), true);
});
