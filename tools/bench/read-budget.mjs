// What a refresh costs, measured in the built bundle.
//
// The panel's whole idle budget is spent on reads: a repository being written
// to by someone else produces a refresh every couple of seconds, and each of
// them used to answer with six Git reads — one per module, including the three
// that had lost their page. Those costs are invisible to a static gate and to
// a unit test, because they are a question about which commands the *running*
// frontend decides to invoke. So this drives the real bundle in a renderer,
// with the Rust side replaced by a counting stub, and asks five things of it:
//
//   boot      a repository opening reads the history it shows, and nothing else
//   refresh   a snapshot whose content did not move, reads nothing
//   coverage  only the domains that moved are read, and only while they are on
//             screen — a closed picker does not list the names it is not showing
//   identity  a second repository that reports the same branch, head and counts
//             is still a second repository, and it is read again
//   round trip  switching pages repeatedly leaves the listeners, watchers,
//             timers and DOM node count where it found them, and leaves the
//             balance of event registrations against event releases where it was
//   close     ending the session reads nothing and stops showing what the
//             repository that is no longer open had on screen
//
// The coverage and identity cases patch the snapshot the way the backend
// publishes it — a domain that moved carries its new generation with it. That is
// the whole contract this probe can check: the panel no longer works out from
// Git-shaped fields whether a listing is stale, so a patch that changes those
// fields without the numbers must cost nothing, and a change of numbers alone
// must cost exactly the read that owns it.
//
// Usage: node read-budget.mjs [dist-dir] [port]
//   e.g. node tools/bench/read-budget.mjs app/dist 9222
//   (the path is read against the current directory; omitting it uses the
//   built bundle at app/dist, found from this script's own location)
//
// It needs a browser and a built bundle, so it lives here rather than beside
// the node:test unit tests: a file under tests/ is executed by
// `npm run test:fixture`, and that run has neither a browser nor a display.
// Launch one first:
//   msedge --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/guit-edge

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request } from "node:http";
import { connect } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.argv[2] || join(here, "..", "..", "app", "dist"));
const PORT = Number(process.argv[3] || 9222);
const CDP = `http://127.0.0.1:${PORT}`;

// Every read that a refresh could ask for, and the domain it belongs to. A name
// that appears in neither is a read the panel has no screen for at all.
// `commit_files` is in none of the three: it answers a selection rather than a
// snapshot, so a refresh must never cause one.
const GRAPH_READS = ["history_page"];
const REFS_READS = ["list_refs"];
const NEVER_READ = ["stash_list", "list_worktrees", "submodule_status", "commit_files"];

const fileView = (id, group, display, extra) => ({
  id,
  display,
  renameFrom: null,
  group,
  indexStatus: group === "staged" ? "M" : " ",
  worktreeStatus: group === "worktree" ? "M" : " ",
  staged: group === "staged",
  unstaged: group === "worktree",
  conflict: group === "conflict",
  untracked: group === "untracked",
  submodule: false,
  ...extra,
});

const FILES = [
  fileView(1, "conflict", "conflict.txt"),
  fileView(2, "staged", "app/src/style.css"),
  fileView(3, "worktree", "app/src/main.ts"),
  fileView(4, "untracked", "notes.txt"),
];

const commit = (index) => ({
  oid: String(index).padStart(40, "0"),
  parents: index === 39 ? [] : [String(index + 1).padStart(40, "0")],
  subject: `commit subject line number ${index}`,
  message: `commit subject line number ${index}`,
  authorName: "dev",
  authorEmail: "dev@example.com",
  authorDate: "2026-09-26T12:00:00+08:00",
  committerName: "dev",
  commitDate: "2026-09-26T12:00:00+08:00",
  refs: index === 0 ? ["HEAD -> master"] : [],
  labels: { branches: index === 0 ? ["master"] : [], tags: [], remotes: [], head: index === 0 },
  graph: {
    node: 0, entry: index === 0, exit: index !== 39, merge: false, root: index === 39,
    lanes: [], branches: [], incoming: [], dangling: false, folded: false,
  },
});
const COMMITS = Array.from({ length: 40 }, (_, index) => commit(index));

const BASE = {
  version: 1,
  // Minted by the backend, never derived from what Git reported: two clones of
  // one repository agree on every field below and disagree on this one.
  sessionId: 1,
  historyGeneration: 0,
  refsGeneration: 0,
  repo: {
    openPath: "/home/dev/project",
    root: "/home/dev/project",
    gitDir: "/home/dev/project/.git",
    bare: false,
    linkedWorktree: false,
  },
  branch: {
    name: "master",
    headState: "branch",
    oid: "bb655b5b0a9569eabec926ae08104a1e39104612",
    upstream: "origin/master",
    ahead: 0,
    behind: 0,
  },
  files: FILES,
  operation: null,
};

const REFS = {
  branches: [{ name: "master", current: true, oid: "bb655b5b", upstream: "origin/master", ahead: 0, behind: 0, remote: "origin", upstreamGone: false, addressable: true }],
  remotes: [],
  tags: [],
};

// A page of commits that can be told apart from the real one by looking at the
// rendered text. This is what makes the stale-answer case decidable: the panel
// has to drop the page it asked for as another repository, and a check that only
// counts rows cannot tell a dropped page from a page that was never asked for.
const STALE_COMMITS = COMMITS.map((entry) => ({
  ...entry,
  subject: "a page from the repository that was left behind",
  message: "a page from the repository that was left behind",
}));

// Counting what the page attaches, before any of the application's code runs.
// Element-level listeners are not counted: those live and die with a row that is
// rebuilt on every paint, so a total would grow whether or not anything leaked.
// `window`, `document`, resize watchers, one-shot timers waiting to fire and
// repeating timers still running are the things that outlive a repaint, and they
// are what a round trip has to return to rest.
const INSTRUMENT = `(() => {
  const counts = { window: 0, document: 0, observers: 0, timers: 0 };
  window.__COUNTS__ = counts;
  const targets = new WeakMap();
  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  const name = (target) => target === window ? "window" : target === document ? "document" : null;
  proto.addEventListener = function (type, handler, options) {
    const key = name(this);
    if (key && handler) {
      const per = targets.get(this) || new Set();
      const id = type + "|" + (options === true ? 1 : 0) + "|" + (typeof handler === "function" ? handler : handler.handleEvent);
      if (!per.has(id)) { per.add(id); counts[key] += 1; }
      targets.set(this, per);
    }
    return add.call(this, type, handler, options);
  };
  proto.removeEventListener = function (type, handler, options) {
    const key = name(this);
    const per = key && targets.get(this);
    if (per) {
      const id = type + "|" + (options === true ? 1 : 0) + "|" + (typeof handler === "function" ? handler : handler && handler.handleEvent);
      if (per.delete(id)) counts[key] -= 1;
    }
    return remove.call(this, type, handler, options);
  };
  const RealObserver = window.ResizeObserver;
  if (RealObserver) {
    window.ResizeObserver = class TrackedResizeObserver extends RealObserver {
      constructor(callback) {
        super(callback);
        counts.observers += 1;
        this.__live = true;
      }
      disconnect() {
        if (this.__live) { this.__live = false; counts.observers -= 1; }
        super.disconnect();
      }
    };
  }
  const setTimer = window.setTimeout;
  const clearTimer = window.clearTimeout;
  const pending = new Set();
  let serial = 0;
  window.setTimeout = function (fn, delay, ...rest) {
    const id = ++serial;
    return setTimer.call(window, function () {
      pending.delete(id);
      if (typeof fn === "function") return fn.apply(window, rest);
      return undefined;
    }, delay);
  };
  window.clearTimeout = function (id) { pending.delete(id); return clearTimer.call(window, id); };
  Object.defineProperty(window.__COUNTS__, "timers", { get: () => pending.size });
  // A repeating timer is its own column and never joins the pending one-shot
  // count: that set drops its id when the callback fires, so an interval that
  // leaked every page switch would report 0 — the exact shape this column exists
  // to catch. Intervals are counted while they are alive, which is what a round
  // trip has to return to.
  const setIntervalFn = window.setInterval;
  const clearIntervalFn = window.clearInterval;
  const registered = new Set();
  let live = 0;
  window.setInterval = function (fn, delay, ...rest) {
    live += 1;
    const id = setIntervalFn.call(window, function () {
      if (typeof fn === "function") return fn.apply(window, rest);
      return undefined;
    }, delay);
    registered.add(id);
    return id;
  };
  window.clearInterval = function (id) {
    if (registered.delete(id)) live -= 1;
    return clearIntervalFn.call(window, id);
  };
  Object.defineProperty(window.__COUNTS__, "intervals", { get: () => live });
})();`;

const STUB = `(() => {
  window.__CALLS__ = Object.create(null);
  window.__SNAPSHOT__ = ${JSON.stringify(BASE)};
  window.__HEAD__ = ${JSON.stringify(commit(0).oid)};
  const REFS = ${JSON.stringify(REFS)};
  const COMMITS = ${JSON.stringify(COMMITS)};
  const STALE_COMMITS = ${JSON.stringify(STALE_COMMITS)};
  // Bound reads answer as the backend does: the value wrapped in the context the
  // request carried. __HOLD__ parks an answer in flight so a case can move the
  // screen while the read is still out, and release it afterwards.
  const held = [];
  const table = {
    restore_repository: () => window.__SNAPSHOT__,
    refresh_repository: () => Object.assign({}, window.__SNAPSHOT__, { version: ++window.__VERSION__ }),
    list_recent_repositories: () => ["/home/dev/project"],
    list_refs: (A) => ({ context: A.context, value: REFS }),
    history_page: (A) => {
      const answer = { context: A.context, value: { commits: window.__STALE__ ? STALE_COMMITS : COMMITS, hasMore: false } };
      if (!window.__HOLD__) return answer;
      return new Promise((done) => { held.push(() => done(answer)); });
    },
    commit_files: (A) => ({ context: A.context, value: [] }),
    show_tag: (A) => ({ context: A.context, value: { name: "v1", oid: "c".repeat(40), targetOid: "0".repeat(40), annotated: false, message: "" } }),
    stash_list: (A) => ({ context: A.context, value: [] }),
    list_worktrees: (A) => ({ context: A.context, value: [] }),
    submodule_status: (A) => ({ context: A.context, value: [] }),
    probe_git: () => ({ available: true, version: "2.53.0", executable: "/usr/bin/git", supported: true, hasRestore: true, message: "" }),
    probe_external_tools: () => ({ difftool: "meld", mergetool: "meld", opener: "xdg-open" }),
    load_window_settings: () => null,
    save_window_settings: () => null,
    restore_window_settings: () => null,
  };
  window.__VERSION__ = 1;
  window.__CALLS__ = Object.create(null);
  window.__RESET__ = () => { window.__CALLS__ = Object.create(null); };
  window.__RELEASE__ = () => { held.splice(0).forEach((finish) => finish()); };
  window.__RESET_ALL__ = (patch) => {
    Object.assign(window.__SNAPSHOT__, { sessionId: 1, historyGeneration: 0, refsGeneration: 0 }, patch);
    window.__HOLD__ = false;
    window.__STALE__ = false;
    document.querySelector('.appbar [aria-label="Refresh status"]').click();
  };
  // Move one domain the way the backend does: a new number, and the Git-shaped
  // fields that number was counted from.
  window.__MOVE__ = (domain, patch) => {
    const next = Object.assign({}, window.__SNAPSHOT__, patch || {});
    if (domain === "graph" || domain === "both") next.historyGeneration += 1;
    if (domain === "refs" || domain === "both") next.refsGeneration += 1;
    window.__SNAP__(next);
  };
  // A second repository: a new session over the same branch, head and counts.
  window.__OPEN__ = (patch) => {
    window.__SNAP__(Object.assign({}, window.__SNAPSHOT__, {
      sessionId: (window.__SNAPSHOT__.sessionId || 1) + 1,
      historyGeneration: 0,
      refsGeneration: 0,
    }, patch));
  };
  window.__SNAP__ = (patch) => {
    Object.assign(window.__SNAPSHOT__, patch);
    document.querySelector('.appbar [aria-label="Refresh status"]').click();
  };
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      const A = args || {};
      window.__CALLS__[cmd] = (window.__CALLS__[cmd] || 0) + 1;
      if (typeof cmd === "string" && cmd.endsWith("|listen")) {
        const id = A.handler;
        window["_" + id] = window["_" + id] || (() => {});
        return Promise.resolve(id);
      }
      if (Object.prototype.hasOwnProperty.call(table, cmd)) return Promise.resolve(table[cmd](A));
      return Promise.resolve(null);
    },
    transformCallback: (cb) => { const id = Math.random().toString(36).slice(2); window["_" + id] = cb; return id; },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
  window.__TAURI__ = { event: { listen: () => Promise.resolve(() => {}) } };
  // The real listen reaches the page through invoke("plugin:event|listen")
  // above, so a registration is counted. Releasing one is not the mirror image:
  // @tauri-apps/api reads this global unconditionally, before it invokes
  // plugin:event|unlisten. Without it the release rejects inside the library
  // and never arrives as a call — a page that leaked every listener it made
  // would still look clean here.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})();`;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serve(root) {
  return new Promise((ready) => {
    const server = createServer((req, resp) => {
      const path = new URL(req.url, "http://x").pathname;
      let body;
      try {
        body = readFileSync(join(root, path === "/" ? "index.html" : path));
      } catch {
        resp.writeHead(404);
        resp.end("not found");
        return;
      }
      resp.writeHead(200, { "content-type": MIME[path.slice(path.lastIndexOf("."))] || "application/octet-stream" });
      resp.end(body);
    });
    server.listen(0, "127.0.0.1", () => ready({
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => server.close(),
    }));
  });
}

const httpJson = (url, method = "GET") => new Promise((done, fail) => {
  request(url, { method }, (response) => {
    let body = "";
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => done(JSON.parse(body)));
  }).on("error", fail).end();
});

function openSocket(url) {
  return new Promise((done, fail) => {
    const target = new URL(url);
    const key = Buffer.from(Math.random().toString(36)).toString("base64").slice(0, 22) + "==";
    const socket = connect(Number(target.port), target.hostname, () => {
      socket.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n");
    });
    const handlers = [];
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const waiting = new Map();
    const send = (text) => {
      const payload = Buffer.from(text);
      const mask = Buffer.from([1, 2, 3, 4]);
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else {
        const size = Buffer.alloc(2);
        size.writeUInt16BE(payload.length);
        header = Buffer.concat([Buffer.from([0x81, 0x80 | 126]), size]);
      }
      const masked = Buffer.alloc(payload.length);
      for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
      socket.write(Buffer.concat([header, mask, masked]));
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        done({
          call: (method, params) => new Promise((resolveCall, rejectCall) => {
            const id = nextId++;
            const timer = setTimeout(() => { waiting.delete(id); rejectCall(new Error("timeout " + method)); }, 20000);
            waiting.set(id, {
              resolve: (value) => { clearTimeout(timer); resolveCall(value); },
              reject: (error) => { clearTimeout(timer); rejectCall(error); },
            });
            send(JSON.stringify({ id, method, params }));
          }),
          close: () => socket.destroy(),
        });
      }
      while (upgraded && buffer.length >= 2) {
        const second = buffer[1];
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const frame = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        for (const handler of handlers) handler(frame);
      }
    });
    socket.on("error", fail);
    handlers.push((frame) => {
      const message = JSON.parse(frame.toString());
      const entry = waiting.get(message.id);
      if (!entry) return;
      waiting.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const fails = [];
  const check = (label, ok, detail) => {
    console.log((ok ? "ok:   " : "FAIL: ") + label + (detail === undefined ? "" : `  [${detail}]`));
    if (!ok) fails.push(label);
  };
  const server = await serve(DIST);
  const target = await httpJson(`${CDP}/json/new?about:blank`, "PUT");
  const session = await openSocket(target.webSocketDebuggerUrl);
  await session.call("Runtime.enable");
  await session.call("Page.enable");
  await session.call("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT + "\n" + STUB });
  await session.call("Emulation.setDeviceMetricsOverride", {
    width: 900, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await session.call("Page.navigate", { url: `${server.origin}/index.html?budget=1` });
  await sleep(1800);

  const evaluate = async (expression) => {
    const result = await session.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
    return result.result.value;
  };
  const calls = () => evaluate("JSON.stringify(window.__CALLS__)").then((text) => JSON.parse(text));
  const counts = () => evaluate(
    "JSON.stringify({window: __COUNTS__.window, document: __COUNTS__.document, observers: __COUNTS__.observers, timers: __COUNTS__.timers, intervals: __COUNTS__.intervals, nodes: document.querySelectorAll('*').length})",
  ).then((text) => JSON.parse(text));
  // Runs one driver in the page, then reports only the commands it caused.
  const spent = async (driver) => {
    await evaluate("window.__RESET__()");
    await evaluate(driver);
    await sleep(600);
    return calls();
  };
  const total = (tally, names) => names.reduce((sum, name) => sum + (tally[name] || 0), 0);

  if (!(await evaluate("!!document.querySelector('.shell')"))) throw new Error("the shell did not boot");

  const boot = await calls();
  check("boot reads the history it shows, once", total(boot, GRAPH_READS) === 1, JSON.stringify(boot));
  check("boot does not list refs for a closed picker", total(boot, REFS_READS) === 0);
  check("boot reads nothing that has no page", total(boot, NEVER_READ) === 0, NEVER_READ.filter((n) => boot[n]).join(","));

  const refreshed = await spent(`
    window.__SNAPSHOT__.files = ${JSON.stringify([...FILES, fileView(5, "worktree", "app/src/state.ts")])};
    document.querySelector('.appbar [aria-label="Refresh status"]').click();
    document.querySelector('.appbar [aria-label="Refresh status"]').click();
    document.querySelector('.appbar [aria-label="Refresh status"]').click();
  `);
  check("a refresh that moved nothing reads nothing", total(refreshed, [...GRAPH_READS, ...REFS_READS, ...NEVER_READ]) === 0, JSON.stringify(refreshed));

  const moved = await spent(`window.__MOVE__("graph", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { oid: "${String(1).padStart(40, "0")}" }) })`);
  check("a moved head re-reads the graph only", total(moved, GRAPH_READS) === 1 && total(moved, REFS_READS) === 0, JSON.stringify(moved));

  const opened = await spent(`document.querySelector('.appbar-branch').click()`);
  check("opening the picker reads the names once", total(opened, REFS_READS) === 1, JSON.stringify(opened));

  const whileOpen = await spent(`window.__MOVE__("refs", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { behind: 3 }) });`);
  check("a picker on screen follows the counts it shows", total(whileOpen, REFS_READS) === 1, JSON.stringify(whileOpen));

  const filesOnly = await spent(`
    window.__SNAP__({ files: ${JSON.stringify(FILES)} });
  `);
  check("changed files alone ask for no listing", total(filesOnly, [...GRAPH_READS, ...REFS_READS, ...NEVER_READ]) === 0, JSON.stringify(filesOnly));

  // The Git-shaped fields say the same thing as before; only the session differs.
  // Nothing the panel can see in a snapshot tells these two repositories apart,
  // which is the entire reason the backend counts them.
  const second = await spent(`window.__OPEN__({});`);
  check("a second repository with the same head is re-read, not inherited",
    total(second, GRAPH_READS) === 1 && total(second, REFS_READS) === 1, JSON.stringify(second));

  await evaluate(`document.querySelector('.appbar [aria-label="Main"]').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); "closed"`);
  const closed = await spent(`window.__MOVE__("refs", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { ahead: 9 }) })`);
  check("a closed picker is not re-read by a refresh", total(closed, REFS_READS) === 0, JSON.stringify(closed));

  // A read asked for one repository that answers after the panel has moved to
  // another. The answer carries the context it was asked with, so the view can
  // drop it; a page of commits from the repository that was left behind must not
  // appear in the graph of the one now open.
  const stale = await spent(`
    window.__HOLD__ = true;
    window.__STALE__ = true;
    window.__MOVE__("graph", {});
  `);
  check("the held read asked for the page", total(stale, GRAPH_READS) === 1, JSON.stringify(stale));
  await spent(`
    window.__HOLD__ = false;
    window.__STALE__ = false;
    window.__OPEN__({});
  `);
  const freshRows = await evaluate(`(() => {
    const pane = document.querySelector('.history-view');
    return [pane.querySelectorAll('[id^="commit-row-"]').length, /repository that was left behind/.test(pane.textContent)];
  })()`);
  check("the new repository's page is what the graph shows", freshRows[0] > 0 && !freshRows[1], JSON.stringify(freshRows));
  await spent(`window.__RELEASE__();`);
  const afterRelease = await evaluate(`(() => {
    const pane = document.querySelector('.history-view');
    return [/repository that was left behind/.test(pane.textContent), pane.querySelectorAll('[id^="commit-row-"]').length];
  })()`);
  check("a page that answers after the screen moved is dropped",
    !afterRelease[0] && afterRelease[1] === freshRows[0], JSON.stringify(afterRelease));
  await spent(`
    window.__HOLD__ = false;
    window.__STALE__ = false;
    window.__RESET_ALL__(${JSON.stringify(BASE)});
  `);
  const before = await counts();
  const eventsBefore = await calls();
  const ROUNDS = `
    for (let round = 0; round < 12; round++) {
      document.querySelector('.appbar [aria-label="Settings"]').click();
      document.querySelector('.appbar [aria-label="Main"]').click();
    }
  `;
  // Not `spent`: that clears the tally first, and the point here is the balance
  // the round trips leave behind, which only a running count can show.
  await evaluate(ROUNDS);
  await sleep(600);
  const after = await counts();
  const eventsAfter = await calls();
  const fields = ["window", "document", "observers", "timers", "intervals", "nodes"];
  for (const field of fields) {
    check(`twelve page round trips leave ${field} where they were`,
      before[field] === after[field], `${before[field]} -> ${after[field]}`);
  }
  // The event channel is the one face of this panel with no compiler across it:
  // an `emit` in Rust and a `listen` here agree only because somebody remembered.
  // Registering is visible to the tally because it is an invoke like any read;
  // releasing is visible only because the stub defines
  // `__TAURI_EVENT_PLUGIN_INTERNALS__` — without it the library rejects before it
  // gets as far as invoking, so a page that never let a listener go still looked
  // clean. The claim is about the balance, not the absolute: what this can see is
  // that a release was called and counts up. What it cannot see is the backend's
  // registry, because there is no Rust side in this run. The expected balance is 0
  // — these listeners are attached once and kept for the life of the window,
  // because the backend pushes for as long as the session lives.
  const balance = (tally) =>
    (tally["plugin:event|listen"] || 0) - (tally["plugin:event|unlisten"] || 0);
  check("twelve page round trips leave the event listeners balanced",
    balance(eventsBefore) === balance(eventsAfter),
    `${balance(eventsBefore)} -> ${balance(eventsAfter)} (${JSON.stringify(eventsAfter["plugin:event|listen"])}|${JSON.stringify(eventsAfter["plugin:event|unlisten"])})`);
  // Absolute rather than a difference, because the rule it stands for is a rule
  // about the panel as a whole: one interval exists, no matter how many pages,
  // repositories or age lines are drawn. A settings change that starts a second
  // timer instead of replacing the first fails here.
  check("the panel holds exactly one repeating timer",
    after.intervals === 1, `${after.intervals} live intervals`);
  // One more refresh after all those page switches: a round trip that left a
  // duplicate listener, a timer or a held snapshot behind would cost more than the
  // one graph read it costs here.
  const afterRounds = await spent(`window.__MOVE__("graph", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { oid: "${String(2).padStart(40, "0")}" }) })`);
  check("a moved head still costs one graph read after twelve round trips",
    total(afterRounds, [...GRAPH_READS, ...REFS_READS, ...NEVER_READ]) === 1, JSON.stringify(afterRounds));

  // Ending the session is the one snapshot transition that is not a read, and
  // the graph has to answer it: a list of commits from a repository that is no
  // longer open says something about the screen that is no longer true.
  const ended = await spent(`document.querySelector('.appbar [aria-label="Close session"]').click()`);
  check("closing the session reads nothing", total(ended, [...GRAPH_READS, ...REFS_READS, ...NEVER_READ]) === 0, JSON.stringify(ended));
  check("closing the session clears the graph it was showing", await evaluate(`(() => {
    const rows = document.querySelectorAll('[id^="commit-row-"]').length;
    const empty = document.querySelector('.history-view .empty-state');
    const list = document.querySelector('.history-view .history-list');
    return rows === 0 && empty !== null && !empty.hidden && list !== null && list.hidden;
  })()`), await evaluate("[document.querySelectorAll('[id^=\"commit-row-\"]').length, !document.querySelector('.history-view .empty-state').hidden].join('/')"));

  console.log(fails.length === 0 ? "\nread budget: fails=0" : `\nread budget: fails=${fails.length}`);
  session.close();
  server.close();
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
