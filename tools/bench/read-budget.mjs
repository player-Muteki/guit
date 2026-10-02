// What a refresh costs, measured in the built bundle.
//
// The panel's whole idle budget is spent on reads: a repository being written
// to by someone else produces a refresh every couple of seconds, and each of
// them used to answer with six Git reads — one per module, including the three
// that had lost their page. Those costs are invisible to a static gate and to
// a unit test, because they are a question about which commands the *running*
// frontend decides to invoke. So this drives the real bundle in a renderer,
// with the Rust side replaced by a counting stub, and asks these of it:
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
//   interval    using the refresh-period row re-arms the one repeating timer rather
//             than adding a second, and costs no read at all
//   search    a keystroke asks one read for the one question it means; the wait
//             the field keeps before asking is counted inside the measured
//             number rather than outside it; and a move of the history re-asks
//             the question the rows on screen already answer, once
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
// Its own column because it belongs to no snapshot: a search read is caused by a
// keystroke, so every case above that counts a refresh must also be able to say
// that the field asked for nothing.
const SEARCH_READS = ["search_repository"];
// The commands that stop work rather than ask for it. A cancellation carries no
// repository state and produces no answer, so it is counted on its own: folded
// into the reads it would either hide a scan that is still walking the history
// or make a read budget that never wanted to count it look wrong.
const CANCELLATIONS = ["cancel_search"];

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
  // A row carries no name. What a commit is called arrives from `list_refs`,
  // which is a second read on a second counter, so `refsAt` below is where the
  // labels come from rather than anything in here.
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
    displayName: "project",
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
  const delays = [];
  let live = 0;
  window.setInterval = function (fn, delay, ...rest) {
    live += 1;
    delays.push(delay);
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
  // The periods every repeating timer in this page was armed with, in order. The
  // live count says how many timers exist; this says whether a settings change
  // *moved* the one that exists or merely added another beside it — the failure a
  // count of 1 cannot see is a panel that stopped honouring the chosen period.
  Object.defineProperty(window.__COUNTS__, "intervalDelays", { get: () => delays.slice() });
})();`;

const STUB = `(() => {
  window.__CALLS__ = Object.create(null);
  window.__SNAPSHOT__ = ${JSON.stringify(BASE)};
  window.__HEAD__ = ${JSON.stringify(commit(0).oid)};
  const COMMITS = ${JSON.stringify(COMMITS)};
  const STALE_COMMITS = ${JSON.stringify(STALE_COMMITS)};
  // Where each name points, held in the page rather than frozen in a literal: a
  // case moves a branch and the one listing read that follows carries the new
  // answer. Rebuilt per read, so an answer the page mutated cannot shape the next.
  window.__MASTER__ = COMMITS[0].oid;
  window.__TOPIC__ = COMMITS[0].oid;
  window.__TAG__ = COMMITS[1].oid;
  const refsValue = () => ({
    branches: [
      { name: "master", oid: window.__MASTER__, head: true, upstream: "origin/master",
        ahead: 0, behind: 0, upstreamGone: false, addressable: true },
      { name: "topic", oid: window.__TOPIC__, head: false, upstream: null,
        ahead: 0, behind: 0, upstreamGone: false, addressable: true },
    ],
    remotes: [
      { name: "origin/master", oid: window.__MASTER__, symref: null, addressable: true },
      { name: "origin/topic", oid: window.__TOPIC__, symref: null, addressable: true },
    ],
    tags: [
      { name: "v1", oid: "f".repeat(40), targetType: "commit", commitOid: window.__TAG__,
        annotated: true, addressable: true },
    ],
  });
  // Bound reads answer as the backend does: the value wrapped in the context the
  // request carried. __HOLD__ parks an answer in flight so a case can move the
  // screen while the read is still out, and release it afterwards.
  const held = [];
  let topmost = true;
  const table = {
    "plugin:window|is_always_on_top": () => topmost,
    "plugin:window|set_always_on_top": (args) => { topmost = args.value; return null; },
    restore_repository: () => window.__SNAPSHOT__,
    refresh_repository: () => Object.assign({}, window.__SNAPSHOT__, { version: ++window.__VERSION__ }),
    list_recent_repositories: () => ["/home/dev/project"],
    list_refs: (A) => {
      if (window.__FAIL__) return new Promise((done, fail) => fail(new Error("git refused to list the refs")));
      return { context: A.context, value: refsValue() };
    },
    history_page: (A) => {
      const answer = { context: A.context, value: { commits: window.__STALE__ ? STALE_COMMITS : COMMITS, hasMore: false } };
      if (!window.__HOLD__) return answer;
      return new Promise((done) => { held.push(() => done(answer)); });
    },
    // One window of a walk, answered the way the backend shapes it: the rows the
    // query matched, the head the offsets count back from, and the names on the
    // first window only. It answers in a microtask, so every number this probe
    // reports for a keystroke is the panel's own share and the wait in front of
    // it — never the walk, which is measured beside it and not here.
    search_repository: (A) => {
      const needle = String((A && A.query) || "");
      const cursor = Number((A && A.cursor) || 0);
      const low = needle.toLowerCase();
      const frag = (text) => {
        const at = text.toLowerCase().indexOf(low);
        if (at < 0) return null;
        return [{ byteStart: at, byteEnd: at + needle.length, unitStart: at, unitEnd: at + needle.length }];
      };
      const commits = [];
      COMMITS.forEach((one, index) => {
        const fragments = frag(one.message);
        if (fragments === null) return;
        commits.push({
          oid: one.oid,
          message: one.message,
          subjectEndBytes: one.message.length,
          subjectEndUnits: one.message.length,
          authorName: one.authorName,
          commitDate: one.commitDate,
          offset: index,
          hits: [{ field: "subject", tier: "contiguous", fragments }],
        });
      });
      const refs = [];
      if (cursor === 0) {
        for (const branch of refsValue().branches) {
          const fragments = frag(branch.name);
          if (fragments !== null) refs.push({ kind: "branch", name: branch.name, commitOid: branch.oid,
            head: branch.head, reachedFromHead: true, tier: "contiguous", fragments });
        }
        const fragments = frag("v1");
        if (fragments !== null) refs.push({ kind: "tag", name: "v1", commitOid: window.__TAG__,
          head: false, reachedFromHead: true, tier: "contiguous", fragments });
      }
      return { context: A.context, value: {
        queryId: A.queryId,
        head: window.__SNAPSHOT__.branch.oid,
        refsGeneration: window.__SNAPSHOT__.refsGeneration,
        window: { cursor, scanned: COMMITS.length, complete: false, stoppedBy: null,
          nextCursor: COMMITS.length, hitsTruncated: false, commits, refs },
      } };
    },
    commit_files: (A) => ({ context: A.context, value: [] }),
    show_tag: (A) => ({ context: A.context, value: { name: "v1", oid: "c".repeat(40), targetType: "commit", commitOid: window.__TAG__, annotated: true, message: "" } }),
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
    window.__MASTER__ = COMMITS[0].oid;
    window.__TOPIC__ = COMMITS[0].oid;
    window.__TAG__ = COMMITS[1].oid;
    window.__HOLD__ = false;
    window.__STALE__ = false;
    window.__FAIL__ = false;
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
  // One keystroke, timed from the input event to the two things a reader waits
  // for: the waiting sentence beside the field, and the first row in the layer.
  // A MutationObserver rather than a poll — its callback is handed to the same
  // microtask checkpoint the paint runs in, so the number is the moment the panel
  // changed its own mind, not the granularity of whatever loop was watching.
  window.__TIMED__ = (text) => new Promise((done) => {
    const view = document.querySelector('.search-view');
    const field = view.querySelector('.search-field');
    const hint = view.querySelector('.search-hint');
    const seen = { hint: -1, row: -1 };
    const start = performance.now();
    const observer = new MutationObserver(() => {
      const at = performance.now() - start;
      if (seen.hint < 0 && hint.textContent.indexOf('Searching') === 0) seen.hint = at;
      if (seen.row < 0 && view.querySelector('.search-row') !== null) seen.row = at;
      if (seen.hint < 0 || seen.row < 0) return;
      observer.disconnect();
      done([seen.hint, seen.row]);
    });
    observer.observe(view, { subtree: true, childList: true, characterData: true, attributes: true });
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // The same question asked twenty times, with the field emptied in between so
  // every sample starts from a closed layer and an answer already on its way
  // cannot overlap the next one. Emptying asks for nothing; the count taken
  // around this loop is where that is checked.
  window.__WARM__ = (text, times) => (async () => {
    const samples = [];
    for (let index = 0; index < times; index += 1) {
      const field = document.querySelector('.search-field');
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((settle) => setTimeout(settle, 40));
      samples.push(await window.__TIMED__(text));
    }
    return samples;
  })();
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

// Nearest-rank: the first value at or above the fraction of samples, so a p95
// over twenty readings is the nineteenth of them sorted rather than the largest
// one wearing somebody else's name. Twenty is the floor a performance unit has
// to be measured at, and it is what makes reporting a p95 here mean anything.
const quantile = (values, fraction) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
};

// The wait the field keeps before it asks, read out of the source it is exported
// from rather than repeated here. The reason is the measurement below: a bar
// charged from the keystroke has to be compared against a number that contains
// the wait, and a constant held only in this file could be quietly out of date
// with the one the panel runs on.
const exportedDebounce = () => {
  const source = readFileSync(join(here, "..", "..", "app", "src", "searchModel.ts"), "utf8");
  const found = /export const SEARCH_DEBOUNCE_MS = (\d+)/.exec(source);
  if (found === null) throw new Error("searchModel.ts no longer exports SEARCH_DEBOUNCE_MS");
  return Number(found[1]);
};

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
  // Which names a drawn row carries. A listing arrives as the chips in a row's
  // first cell, so this is the only channel that can see a name move from one
  // commit to another — a count of reads cannot tell a moved name from a redraw.
  const chips = async (index) => evaluate(`(() => {
    const row = document.querySelector('#commit-row-${index}');
    if (row === null) return null;
    return [...row.querySelectorAll('.commit-ref')].map((node) => node.textContent);
  })()`);

  if (!(await evaluate("!!document.querySelector('.shell')"))) throw new Error("the shell did not boot");

  const boot = await calls();
  check("boot reads the history it shows, once", total(boot, GRAPH_READS) === 1, JSON.stringify(boot));
  check("boot reads the names it shows, once", total(boot, REFS_READS) === 1, JSON.stringify(boot));
  check("boot asks the empty field nothing", total(boot, SEARCH_READS) === 0, JSON.stringify(boot));
  check("boot reads nothing that has no page", total(boot, NEVER_READ) === 0, NEVER_READ.filter((n) => boot[n]).join(","));
  // The join is by the commit each name points at, so a listing that arrived is
  // only worth having if its names sit on the right rows.
  const [atBoot0, atBoot1, atBoot2] = await Promise.all([chips(0), chips(1), chips(2)]);
  check("a name lands on the commit it points at",
    atBoot0 !== null && atBoot0.includes("master") && atBoot0.includes("topic")
      && atBoot1 !== null && atBoot1.includes("v1")
      && atBoot2 !== null && atBoot2.length === 0,
    JSON.stringify([atBoot0, atBoot1, atBoot2]));

  const refreshed = await spent(`
    window.__SNAPSHOT__.files = ${JSON.stringify([...FILES, fileView(5, "worktree", "app/src/state.ts")])};
    document.querySelector('.appbar [aria-label="Refresh status"]').click();
    document.querySelector('.appbar [aria-label="Refresh status"]').click();
    document.querySelector('.appbar [aria-label="Refresh status"]').click();
  `);
  check("a refresh that moved nothing reads nothing", total(refreshed, [...GRAPH_READS, ...REFS_READS, ...SEARCH_READS, ...NEVER_READ]) === 0, JSON.stringify(refreshed));

  const moved = await spent(`window.__MOVE__("graph", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { oid: "${String(1).padStart(40, "0")}" }) })`);
  check("a move that only bumps the history counter asks for the graph alone",
    total(moved, GRAPH_READS) === 1 && total(moved, REFS_READS) === 0, JSON.stringify(moved));

  // The two counters are the backend's own split: a commit moves the head, which
  // is a graph input *and* explains a name, so both advance together and both
  // reads are asked. Nothing here re-reads the other domain by accident.
  const committed = await spent(`window.__MOVE__("both", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { oid: "${String(2).padStart(40, "0")}" }) })`);
  check("a head move that advances both counters costs one read each",
    total(committed, GRAPH_READS) === 1 && total(committed, REFS_READS) === 1, JSON.stringify(committed));

  const opened = await spent(`document.querySelector('.appbar-repo').click(); document.querySelector('.repository-menu [aria-label="Branches and tags"]').click()`);
  check("opening the picker over a listing already read asks for nothing",
    total(opened, REFS_READS) === 0, JSON.stringify(opened));

  const whileOpen = await spent(`window.__MOVE__("refs", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { behind: 3 }) });`);
  check("two views on one refs generation share one listing read",
    total(whileOpen, REFS_READS) === 1, JSON.stringify(whileOpen));

  const names = await spent(`window.__MOVE__("refs", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { behind: 4 }) });`);
  check("a picker on screen follows the counts it shows", total(names, REFS_READS) === 1, JSON.stringify(names));

  const filesOnly = await spent(`
    window.__SNAP__({ files: ${JSON.stringify(FILES)} });
  `);
  check("changed files alone ask for no listing", total(filesOnly, [...GRAPH_READS, ...REFS_READS, ...SEARCH_READS, ...NEVER_READ]) === 0, JSON.stringify(filesOnly));

  // The Git-shaped fields say the same thing as before; only the session differs.
  // Nothing the panel can see in a snapshot tells these two repositories apart,
  // which is the entire reason the backend counts them.
  const second = await spent(`window.__OPEN__({});`);
  check("a second repository with the same head is re-read, not inherited",
    total(second, GRAPH_READS) === 1 && total(second, REFS_READS) === 1, JSON.stringify(second));

  await evaluate(`document.querySelector('.appbar [aria-label="Main"]').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); "closed"`);

  // The exit gate for a structured listing: a branch that moved somewhere the
  // head did not follow. Nothing about the history changed — the topology, the
  // pages and the row heights are all as they were — and only the names answer
  // differently. This is the case a `%D` decoration in the page could not make,
  // because the label lived in the page it was claiming did not move.
  const relabel = await spent(`
    window.__TOPIC__ = "${String(2).padStart(40, "0")}";
    window.__MOVE__("refs", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { ahead: 9 }) });
  `);
  check("a moved branch without a head move re-reads the names and no history",
    total(relabel, REFS_READS) === 1 && total(relabel, GRAPH_READS) === 0, JSON.stringify(relabel));
  const [atMoved0, atMoved1, atMoved2] = await Promise.all([chips(0), chips(1), chips(2)]);
  check("the moved name repaints onto its new commit and the tag stays where it was",
    atMoved0 !== null && !atMoved0.includes("topic") && atMoved0.includes("master")
      && atMoved1 !== null && atMoved1.includes("v1")
      && atMoved2 !== null && atMoved2.includes("topic"),
    JSON.stringify([atMoved0, atMoved1, atMoved2]));

  // A listing that Git refused is a fact about these rows, not an empty column.
  // The read is not cached on failure, so the retry the panel offers is a real
  // second read and the names come back onto the rows they name.
  const refused = await spent(`
    window.__FAIL__ = true;
    window.__MOVE__("refs", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { ahead: 10 }) });
  `);
  check("a refused listing asks once and is said out loud",
    total(refused, REFS_READS) === 1
      && (await evaluate(`(() => {
        const line = document.querySelector('.history-count');
        const retry = document.querySelector('.history-list-head [aria-label="Read the branch and tag names again"]');
        return !line.hidden && /names could not be read/.test(line.textContent) && retry !== null && !retry.hidden;
      })()`)),
    JSON.stringify(refused));
  const silentRows = await Promise.all([chips(0), chips(1)]);
  check("a refused listing labels no row, and does not pretend the rows are unlabelled",
    silentRows.every((list) => list !== null && list.length === 0), JSON.stringify(silentRows));

  const repaired = await spent(`
    window.__FAIL__ = false;
    document.querySelector('.history-list-head [aria-label="Read the branch and tag names again"]').click();
  `);
  check("the retry asks for the listing again", total(repaired, REFS_READS) === 1, JSON.stringify(repaired));
  const backAgain = await chips(2);
  check("and the names come back onto the rows they name",
    backAgain !== null && backAgain.includes("topic"), JSON.stringify(backAgain));

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
    total(afterRounds, [...GRAPH_READS, ...REFS_READS, ...SEARCH_READS, ...NEVER_READ]) === 1, JSON.stringify(afterRounds));

  // --- the interval row ---
  //
  // Four requests, in the order a person would make them: a new period, one the
  // range has to clamp, one that is not a number at all, and a fraction. Then the
  // value is put back where it started, because the run that follows this one boots
  // in the same profile. What this is looking for is a panel that re-arms its single
  // repeating timer instead of accumulating one per keystroke — and a settings row
  // that reaches for Git, which is the mistake this whole channel exists to make
  // visible: the period decides how often a sentence is rewritten, nothing more.
  const delaysBefore = (await evaluate("window.__COUNTS__.intervalDelays.length"));
  const intervalRows = await spent(`(() => {
    document.querySelector('.appbar [aria-label="Settings"]').click();
    const box = document.querySelector('[aria-label="Last-modified text refresh, in seconds"]');
    const set = (value) => { box.value = value; box.dispatchEvent(new Event("change")); };
    set("9");
    set("200");
    set("");
    set("2.4");
    set("5");
    document.querySelector('.appbar [aria-label="Main"]').click();
  })()`);
  await sleep(200);
  const armed = await evaluate("JSON.stringify(window.__COUNTS__.intervalDelays.slice(" + delaysBefore + "))");
  check("four uses of the interval row re-arm the one timer, at the period asked for",
    armed === "[9000,60000,2000,5000]", `${armed} (a refused request adds none)`);
  const afterInterval = await counts();
  check("the interval row leaves the panel with one repeating timer",
    afterInterval.intervals === 1, `${afterInterval.intervals} live intervals`);
  check("changing the interval reads nothing",
    total(intervalRows, [...GRAPH_READS, ...REFS_READS, ...SEARCH_READS, ...NEVER_READ]) === 0, JSON.stringify(intervalRows));
  // The field shows the number in force, and storage holds it: the first is what
  // stops a clamped request from leaving a lie in the box, the second is what makes
  // the key a live name rather than one a later build migrates out of nothing.
  check("the interval row ends showing what the panel is running on", await evaluate(`(() => {
    const box = document.querySelector('[aria-label="Last-modified text refresh, in seconds"]');
    return box.value === localStorage.getItem("guit.activityInterval") && box.value === "5";
  })()`));

  // --- the search field ---
  //
  // The field is the one read this panel starts because a person asked for it, so
  // it has its own budget rather than a share of the refresh one: a question
  // walked over the history should cost the history listing nothing, and a
  // refresh should cost the question nothing. The counts below are the shape of
  // that separation. The timing at the end is the other half, and it is taken
  // from the keystroke — which is why the wait is read out of the source and put
  // inside the measured number rather than subtracted from it.
  const keystroke = (text) => `(() => {
    const field = document.querySelector('.search-field');
    field.value = ${JSON.stringify(text)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`;

  const asked = await spent(keystroke("commit"));
  check("one keystroke asks one search read and no other read",
    total(asked, SEARCH_READS) === 1 && total(asked, [...GRAPH_READS, ...REFS_READS, ...NEVER_READ]) === 0,
    JSON.stringify(asked));
  const answered = await evaluate(`(() => {
    const results = document.querySelector('.search-results');
    return [
      !results.hidden,
      document.querySelectorAll('.search-row').length,
      document.querySelector('.search-hint').textContent,
      results.querySelector('.search-footer').textContent,
    ];
  })()`);
  check("the answer is rows and a sentence about them, not a waiting word",
    answered[0] && answered[1] === 40 && answered[2] === "" && /40 commits matched/.test(answered[3]),
    JSON.stringify(answered));

  // The continuation is the same question asked further back, under the same
  // query id, because the backend keys one scan's cancellation on that pair. It
  // is still only a search read: nothing here re-lists the names or re-reads the
  // page the graph is drawing.
  const further = await spent(`document.querySelector('.search-footer button').click()`);
  check("reading further back asks again and touches no other listing",
    total(further, SEARCH_READS) === 1 && total(further, [...GRAPH_READS, ...REFS_READS, ...NEVER_READ]) === 0,
    JSON.stringify(further));

  // An input method tells one question in several keystrokes. Each of them fires
  // an input event, and a scan started on a half-composed character is a scan
  // thrown away — so the middle of a composition costs this panel no read at all,
  // and the text that actually lands is asked once, on the ordinary wait.
  const halfWritten = await spent(`(() => {
    const field = document.querySelector('.search-field');
    field.dispatchEvent(new CompositionEvent('compositionstart'));
    for (const piece of ['n', 'ni', '你']) {
      field.value = piece;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  check("a composition in progress asks for nothing", total(halfWritten, SEARCH_READS) === 0, JSON.stringify(halfWritten));
  const landed = await spent(`(() => {
    document.querySelector('.search-field').dispatchEvent(new CompositionEvent('compositionend'));
  })()`);
  check("the text that lands at the end of one is asked once", total(landed, SEARCH_READS) === 1, JSON.stringify(landed));

  const emptied = await spent(`(() => {
    const field = document.querySelector('.search-field');
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  check("emptying the field asks for nothing and takes the layer down",
    total(emptied, SEARCH_READS) === 0 && (await evaluate("document.querySelector('.search-results').hidden")),
    JSON.stringify(emptied));
  // The scan that was answering the question the reader just took away is
  // stopped where it stands rather than walked to its window's end. A
  // cancellation is not a read, so the count of reads above stays at zero while
  // this one command is emitted exactly once, naming the question by the pair
  // the backend's lane is keyed on.
  check("emptying the field cancels the scan it stopped waiting for, once",
    total(emptied, CANCELLATIONS) === 1, JSON.stringify(emptied));

  // The search reads the history on screen, so it follows the graph's own rule:
  // the backend's counter retired the answer, and the reader's question is still
  // in the field. One re-ask, on the same wait any other keystroke pays — and no
  // second one, which is what a view that re-armed its timer per repaint would
  // cost.
  await spent(keystroke("commit"));
  const historyMoved = await spent(`window.__MOVE__("graph", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { oid: "${String(3).padStart(40, "0")}" }) })`);
  check("a moved history re-asks the question on screen, once, and moves no listing",
    total(historyMoved, SEARCH_READS) === 1 && total(historyMoved, GRAPH_READS) === 1 && total(historyMoved, REFS_READS) === 0,
    JSON.stringify(historyMoved));

  // A names move is the other half of that rule. The rows answer a question about
  // commits, which did not move, so the layer keeps them and asks for nothing —
  // even though the answer it holds carries a names generation older than the
  // screen's, which is a thing the footer says rather than a reason to re-read.
  const namesMoved = await spent(`window.__MOVE__("refs", { branch: Object.assign({}, window.__SNAPSHOT__.branch, { behind: 7 }) })`);
  check("a names move leaves an answer about the history alone and asks for nothing",
    total(namesMoved, SEARCH_READS) === 0 && (await evaluate("document.querySelectorAll('.search-row').length")) === 40,
    JSON.stringify(namesMoved));

  const DEBOUNCE = exportedDebounce();
  await evaluate("window.__RESET__()");
  const samples = await evaluate(`window.__WARM__("commit", 20)`);
  const warm = await calls();
  const hintMs = samples.map((pair) => pair[0]);
  const rowMs = samples.map((pair) => pair[1]);
  const shown = (values) => values.map((one) => one.toFixed(1)).join(" ");
  const state = await evaluate("document.visibilityState");
  console.log(`   keystroke to the waiting sentence  p50 ${quantile(hintMs, 0.5).toFixed(1)}  p95 ${quantile(hintMs, 0.95).toFixed(1)}  [${shown(hintMs)}]`);
  console.log(`   keystroke to the first drawn row   p50 ${quantile(rowMs, 0.5).toFixed(1)}  p95 ${quantile(rowMs, 0.95).toFixed(1)}  [${shown(rowMs)}]`);
  check("twenty keystrokes ask twenty searches and no other read",
    total(warm, SEARCH_READS) === samples.length && total(warm, [...GRAPH_READS, ...REFS_READS, ...NEVER_READ]) === 0,
    `${samples.length} samples, ${JSON.stringify(warm)}`);
  // Not a bar the panel is being held to: a claim about the measurement. Every
  // sample has to contain the wait, and a number below it would mean this channel
  // timed the request instead of the keystroke — the one way it could report a
  // fast panel while the panel asks from a timer nobody is measuring.
  check("the wait is counted inside what is measured",
    quantile(hintMs, 0.5) >= DEBOUNCE && quantile(rowMs, 0.5) >= DEBOUNCE,
    `p50 ${quantile(hintMs, 0.5).toFixed(1)} / ${quantile(rowMs, 0.5).toFixed(1)} against the exported ${DEBOUNCE} ms wait (${state} tab)`);
  // Both bars are the product's own, and both are answered by this channel's part
  // of them only: the stub resolves in a microtask, so the second number is what
  // the reader waits for before a request is even out of the panel, and the walk
  // behind it is measured separately, in Rust, and reported beside it rather than
  // folded into this.
  check("the waiting sentence arrives inside the bar for it",
    quantile(hintMs, 0.95) <= 150,
    `p95 ${quantile(hintMs, 0.95).toFixed(1)} ms, of which ${DEBOUNCE} ms is the wait`);
  check("the first rows arrive inside the bar for them",
    quantile(rowMs, 0.95) <= 500,
    `p95 ${quantile(rowMs, 0.95).toFixed(1)} ms with an answer that costs no Git read`);

  // Ending the session is the one snapshot transition that is not a read, and
  // the graph has to answer it: a list of commits from a repository that is no
  // longer open says something about the screen that is no longer true. The field
  // is left holding a live question here, because that is the case worth
  // measuring — a reader who searches and then closes the repository.
  const askedBeforeClose = await evaluate(`(() => {
    const field = document.querySelector('.search-field');
    return [field.value, document.querySelectorAll('.search-row').length];
  })()`);
  const ended = await spent(`document.querySelector('.appbar [aria-label="Close session"]').click()`);
  check("closing the session reads nothing", total(ended, [...GRAPH_READS, ...REFS_READS, ...SEARCH_READS, ...NEVER_READ]) === 0, JSON.stringify(ended));
  check("closing the session takes the field's answer with it",
    askedBeforeClose[0] === "commit" && askedBeforeClose[1] === 40 && (await evaluate(`(() => {
      const field = document.querySelector('.search-field');
      return field.value === '' && field.disabled && document.querySelector('.search-results').hidden
        && document.querySelectorAll('.search-row').length === 0;
    })()`)),
    JSON.stringify(askedBeforeClose));
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
