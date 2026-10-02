// The four window buttons, and the promises they are bound to.
//
// Every claim here is about wiring that cannot be checked where the behaviour is pure:
// `window.ts` computes nothing about a window, and the desktop's answer only exists in a
// live one. So these are gates over the sources, one per way the panel could quietly
// start lying — a button that destroys instead of closing, a pin that reports the state
// that was asked for, a maximise label that remembers rather than reads, a first run that
// is unpinned while the code says it is pinned, an action the capability file never
// granted, and a close that throws a running operation away without saying so.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const rust = (path) => readFileSync(new URL(`../src-tauri/${path}`, import.meta.url), "utf8");

const shell = source("shell.ts");
const win = source("window.ts");
const main = source("main.ts");

// --- the cluster ---

test("the app bar carries the four window actions in the order a title bar puts them", () => {
  // The order is the product's, not a layout detail: a person who reaches for the corner
  // of a small window has muscle memory from every other window they own.
  assert.match(shell, /windowControls\.append\(pinButton, minimizeButton, maximizeButton, quitButton\)/);
  // One group with one accessible name, so the four read as window controls rather than
  // as four more repository buttons that happen to be at the edge.
  assert.match(shell, /class: "window-controls"[\s\S]{0,120}role: "group"[\s\S]{0,120}"aria-label": "Window"/);
  // Last on the bar, and after the tab strip: the pages are not in the corner, the window
  // is, and a cluster that moved between Main and Settings would not be one cluster.
  const tabs = shell.indexOf("appbar.append(tabs)");
  const cluster = shell.indexOf("appbar.append(windowControls)");
  assert.ok(tabs !== -1 && cluster > tabs, "the window cluster must be the last thing appended to the app bar");
  const appbarArray = shell.match(/const appbar = el\("header", \{ class: "appbar" \}, \[[\s\S]*?\]\);/);
  assert.ok(appbarArray, "the app bar must be built from one array");
  assert.doesNotMatch(appbarArray[0], /pinButton/, "the app-bar array must not also hold the pin, or one button is drawn twice");
});

test("the shell asks for a window action through an injected action, never through the IPC layer", () => {
  // The same seam that keeps Git out of the frontend: `shell.ts` holds no `invoke`, so a
  // window button cannot become a place that calls an ungranted command by hand.
  assert.doesNotMatch(shell, /\binvoke\(/);
  for (const action of ["minimize", "toggleMaximize", "closeWindow"]) {
    assert.match(shell, new RegExp(`actions\\.${action}\\(\\)`), `the shell must delegate ${action}`);
    assert.ok(main.includes(`${action}:`), `main.ts must wire ${action}`);
  }
});

test("every window action is awaited and a refusal is shown as the failure it is", () => {
  // A fired-and-forgotten promise is how a denied permission starts looking like a
  // control that works. Four buttons, four awaited calls, four error paths.
  for (const name of ["setAlwaysOnTop", "minimizeWindow", "toggleMaximized", "closeWindow"]) {
    assert.ok(main.includes(name), `main.ts must call ${name}`);
    const at = main.lastIndexOf(`void ${name}(`);
    assert.ok(at !== -1, `main.ts must await ${name} rather than read its result later`);
    assert.match(main.slice(at, at + 200), /catch\(showError\)/, `${name} must report its failure`);
  }
});

test("the close button requests a close and leaves the destruction to the close hook", () => {
  // The hook is the only path that lets every component go, writes the geometry down and
  // then destroys the window. A button that called `destroy()` itself would close guit
  // and lose the size it was asked to keep.
  const closeWindow = win.slice(win.indexOf("export async function closeWindow"));
  assert.match(closeWindow.slice(0, 300), /currentWindow\.close\(\)/);
  assert.doesNotMatch(closeWindow.slice(0, 300), /destroy\(\)/);
  const hook = win.slice(win.indexOf("onCloseRequested"));
  assert.match(hook, /hooks\.onClosing\(\)[\s\S]*await persistWindowSettings\(\)[\s\S]*currentWindow\.destroy\(\)/);
  // Only one place in the file may destroy.
  assert.equal(win.match(/\.destroy\(\)/g)?.length, 1);
});

test("a close is held before anything is thrown away, on every route onto a close", () => {
  // The hook is the one path: the title bar, the app-bar button and a desktop quit key all
  // arrive here, so a hold asked for here cannot be bypassed by whichever of them was used.
  const hook = win.slice(win.indexOf("onCloseRequested"));
  const veto = hook.indexOf("hooks.vetoClose()");
  assert.ok(veto !== -1, "the close hook must ask before it lets go of anything");
  assert.match(hook, /if \(hooks\.vetoClose\(\)\) return;/);
  for (const step of [
    "window.clearTimeout(saveTimer)",
    "hooks.onClosing()",
    "await persistWindowSettings()",
    "currentWindow.destroy()",
  ]) {
    assert.ok(hook.indexOf(step) > veto, `${step} must follow the answer, so a held close changes nothing`);
  }
  assert.match(main, /installWindowHooks\(\{[\s\S]*?vetoClose,[\s\S]*?onClosing:/);
});

test("the hold names the operation that is running and is released only by the button it shows", () => {
  // A second press of the same corner is not a decision: an accidental double click on a
  // title bar would otherwise be how a commit gets stranded mid-write. So the release is a
  // named control, and the panel says what would be left running in the words it shows.
  const veto = main.slice(main.indexOf("const vetoClose"), main.indexOf("// --- events ---"));
  assert.match(veto, /isWriteRunning\(\)/);
  assert.match(veto, /statusLine\(\)\.message/, "the warning must quote the operation the status line is reporting");
  assert.match(veto, /label: "Close anyway"/);
  assert.match(veto, /closeAccepted = true;/);
  assert.equal(
    main.match(/closeAccepted = true/g)?.length,
    1,
    "only the shown button may release a hold, and a hold released cannot outlive its press",
  );
  // The reading side: an acceptance is taken off the table on every ask, whether or not a
  // write turns out to be running, so nothing armed can carry into a later operation.
  assert.match(veto, /const accepted = closeAccepted;\s*closeAccepted = false;/);
  assert.match(veto, /if \(accepted \|\| !isWriteRunning\(\)\) return false;/);
});

// --- what a button is allowed to say ---

test("the pin reports the state the window is in, not the state that was asked for", () => {
  // The flag moves only through `setTopmost`, which announces to whoever is painted from
  // it: the app-bar button, and the Settings checkbox that owns the same fact.
  assert.match(win, /const actual = await currentWindow\.isAlwaysOnTop\(\);\s*setTopmost\(actual\)/);
  // The flag is assigned in exactly two places: its own declaration, and the one writer
  // that announces it. Anything else that set it directly would move the state without
  // telling the button or the checkbox that are painted from it.
  const writes = [...win.matchAll(/^[^\n]*alwaysOnTop = [^\n]*/gm)].map((match) => match[0].trim());
  assert.deepEqual(writes, ["let alwaysOnTop = false;", "alwaysOnTop = value;"]);
  const writer = win.slice(win.indexOf("function setTopmost"), win.indexOf("export function onAlwaysOnTopChange"));
  assert.match(writer, /alwaysOnTop = value;/, "the direct write must be inside the announcing writer");
  assert.match(win, /preferredOnTop = settings\?\.alwaysOnTop \?\? true/);
  assert.match(win, /await setAlwaysOnTop\(preferredOnTop\)/);
  assert.match(shell, /onDispose\(onAlwaysOnTopChange\(\(\) => render\(\)\)\)/);
});

test("the maximise label is read from the window rather than remembered from the click", () => {
  // A double-click on the native title bar, `Alt+Space` and a refused maximise are three
  // ways into the state this module never saw happen, so the button subscribes.
  assert.match(shell, /onDispose\(onMaximizedChange\(paintMaximize\)\)/);
  assert.match(shell, /value \? "Restore window" : "Maximise window"/);
  assert.match(win, /export async function toggleMaximized\(\): Promise<void> \{\s*if \(await syncMaximized\(\)\)/);
  // The state also moves on a resize, because that is the only notice a title-bar
  // double-click sends.
  assert.match(win, /onResized\(\(\{ payload \}\) => \{[\s\S]{0,400}void syncMaximized\(\)/);
});

test("both window buttons that carry a state name their states in both directions", () => {
  // A control that only ever says "Maximise" is a control that lies once the window is
  // maximised; the same applies to the pressed state of the pin.
  const paint = shell.slice(shell.indexOf("const paintMaximize"), shell.indexOf("onDispose(onAlwaysOnTopChange"));
  assert.match(paint, /"Restore"/);
  assert.match(paint, /"Maximise"/);
  assert.match(shell, /icon\(value \? "restore" : "maximize"\)/);
  assert.match(shell, /pinButton\.setAttribute\("aria-pressed", String\(isAlwaysOnTop\(\)\)\)/);
});

// --- the two files that have to agree about a first run ---

test("a run with nothing stored is pinned, in the window and in the record the panel reads", () => {
  // Rust applies `alwaysOnTop` only when a settings file exists, so the unchosen default
  // has to live in the window configuration as well as in the frontend's default. If
  // either moved alone, the button would say pinned and the desktop would not be.
  assert.match(win, /settings\?\.alwaysOnTop \?\? true/);
  const conf = JSON.parse(rust("tauri.conf.json"));
  assert.equal(conf.app.windows[0].alwaysOnTop, true);
  // An explicit `false` in a stored record is the choice the user did make, so the
  // default must be a `??` and never an `||`.
  assert.doesNotMatch(win, /alwaysOnTop \|\| true/);
});

test("the capability file grants the native actions the four buttons call", () => {
  const capability = JSON.parse(rust("capabilities/default.json"));
  const granted = new Set(capability.permissions);
  for (const permission of [
    "core:window:allow-set-always-on-top",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-unmaximize",
    "core:window:allow-close",
    "core:window:allow-destroy",
  ]) {
    assert.ok(granted.has(permission), `${permission} is called from a window button`);
  }
  assert.equal(JSON.parse(rust("tauri.conf.json")).app.windows[0].decorations, false);
  assert.ok(granted.has("core:window:allow-start-dragging"));
  assert.ok(granted.has("core:window:allow-start-resize-dragging"));
  assert.match(win, /currentWindow\.startDragging\(\)/);
  assert.match(win, /currentWindow\.startResizeDragging\(direction\)/);
  assert.match(win, /event\.detail === 2 \? toggleMaximized/);
  assert.match(win, /menu\.popup\(position\)/);
  assert.match(main, /onDispose\(installWindowChrome\(shell\.appbar, showError\)\)/);
});

test("Linux prefers X11 before GTK initializes while allowing an explicit Wayland choice", () => {
  const entry = rust("src/main.rs");
  const start = entry.indexOf("fn main()");
  const backend = entry.indexOf('gdk::set_allowed_backends("x11,wayland")', start);
  const runtime = entry.indexOf("tauri::Builder::default()", start);
  assert.ok(backend > start && backend < runtime);
  assert.match(entry.slice(start, backend), /#\[cfg\(target_os = "linux"\)\]/);
  assert.match(rust("Cargo.toml"), /\[target\.'cfg\(target_os = "linux"\)'\.dependencies\][\s\S]*?gdk = "0\.18"/);
});
