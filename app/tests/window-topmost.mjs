import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/window.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadWindow({ accepted = true, initial = false, stored = null } = {}) {
  let actual = initial;
  const calls = [];
  const saves = [];
  const scheduled = new Map();
  let timerId = 0;
  const native = {
    async setAlwaysOnTop(value) { calls.push(value); if (accepted) actual = value; },
    async isAlwaysOnTop() { return actual; },
    async isMaximized() { return false; },
    async scaleFactor() { return 1; },
    async outerPosition() { return { x: 10, y: 20 }; },
    async outerSize() { return { width: 720, height: 560 }; },
  };
  const modules = {
    "@tauri-apps/api/window": { getCurrentWindow: () => native },
    "@tauri-apps/api/core": { async invoke(command, args) {
      if (command === "restore_window_settings") return stored;
      if (command === "save_window_settings") { saves.push(args.settings); return; }
      throw new Error("Unexpected command: " + command);
    } },
    "@tauri-apps/api/dpi": {},
    "@tauri-apps/api/menu": {},
    "./dom": {},
  };
  const context = createContext({
    exports: {},
    require(name) { assert.ok(name in modules, name); return modules[name]; },
    window: {
      innerWidth: 720, innerHeight: 560,
      setTimeout(callback, delay) {
        const id = ++timerId;
        if (delay === 400) scheduled.set(id, callback);
        else queueMicrotask(callback);
        return id;
      },
      clearTimeout(id) { scheduled.delete(id); },
    },
  });
  runInContext(compiled, context);
  return { api: context.exports, native, calls, saves };
}

test("a successful request without a changed native state does not claim to be pinned", async () => {
  const { api } = loadWindow({ accepted: false });
  await assert.rejects(api.setAlwaysOnTop(true), /desktop.*always.on.top/i);
  assert.equal(api.isAlwaysOnTop(), false);
});

test("confirmed pin and unpin update the state and saved preference", async () => {
  const { api, calls, saves } = loadWindow();
  const states = [];
  api.onAlwaysOnTopChange((value) => states.push(value));
  await api.setAlwaysOnTop(true);
  assert.equal(api.isAlwaysOnTop(), true);
  await api.persistWindowSettings();
  assert.equal(saves.at(-1).alwaysOnTop, true);
  await api.setAlwaysOnTop(false);
  assert.equal(api.isAlwaysOnTop(), false);
  await api.persistWindowSettings();
  assert.equal(saves.at(-1).alwaysOnTop, false);
  assert.deepEqual(calls, [true, false]);
  assert.deepEqual(states, [true, false]);
});

test("a delayed window-manager acknowledgement is awaited before publishing the pin", async () => {
  const { api, native } = loadWindow();
  let reads = 0;
  native.isAlwaysOnTop = async () => ++reads >= 3;
  await api.setAlwaysOnTop(true);
  assert.equal(reads, 3);
  assert.equal(api.isAlwaysOnTop(), true);
});

test("startup failure preserves the saved preference but does not paint it as applied", async () => {
  const { api, saves } = loadWindow({ accepted: false, stored: { alwaysOnTop: true } });
  await assert.rejects(api.restoreWindowState(), /desktop.*always.on.top/i);
  assert.equal(api.isAlwaysOnTop(), false);
  await api.persistWindowSettings();
  assert.equal(saves.at(-1).alwaysOnTop, true);
});

test("an explicit saved unpin is applied instead of the first-run default", async () => {
  const { api, calls } = loadWindow({ initial: true, stored: { alwaysOnTop: false } });
  await api.restoreWindowState();
  assert.deepEqual(calls, [false]);
  assert.equal(api.isAlwaysOnTop(), false);
});

test("state reconciliation follows a window-manager change outside the app", async () => {
  const { api, native } = loadWindow();
  await api.setAlwaysOnTop(true);
  native.isAlwaysOnTop = async () => false;
  await api.syncAlwaysOnTop();
  assert.equal(api.isAlwaysOnTop(), false);
});

test("a denied native request is reported without setting the pin", async () => {
  const { api, native } = loadWindow();
  native.setAlwaysOnTop = async () => { throw new Error("permission denied"); };
  await assert.rejects(api.setAlwaysOnTop(true), /permission denied/);
  assert.equal(api.isAlwaysOnTop(), false);
});

test("a refused unpin keeps the confirmed pin visible", async () => {
  const { api } = loadWindow({ accepted: false, initial: true });
  await api.syncAlwaysOnTop();
  await assert.rejects(api.setAlwaysOnTop(false), /desktop.*always.on.top/i);
  assert.equal(api.isAlwaysOnTop(), true);
});
