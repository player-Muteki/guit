// Rendering gate for the guit shell: real layout, real sizes.
//
// The static gates (responsive-check.py) prove that a bare `vh` is gone and
// that both axes have a breakpoint. They cannot see the failure the layout
// notes record as real: a section squashed by a column flex container and painted on
// top of the next one, while every accessibility assertion still passed. That
// is a rendering fact, so it is checked in a renderer.
//
// The shell is driven through a stub Tauri IPC so it boots without the Rust
// side, then each view is measured at every interesting shape. Three defects
// are asserted, and they are the three that produce invisible or unusable UI:
//
//   overlap   two nodes that both render text and whose boxes intersect
//   overflow  a node whose right edge leaves the viewport
//   invisible a node that is SHOWING, carries text, and has a box too small
//             to draw it in
//
// Usage: node layout-probe.mjs <dist-dir> [port] [sizes]
//   e.g. node layout-probe.mjs ../../app/dist 9222
//
// It needs a browser and a built bundle, so it lives here rather than beside
// the node:test unit tests: a file under tests/ is executed by
// `npm run test:fixture`, and that run has neither a browser nor a display.
// Launch one first:
//   msedge --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/guit-edge

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.argv[2] || join(here, "..", "dist"));
const PORT = Number(process.argv[3] || 9222);
const CDP = `http://127.0.0.1:${PORT}`;

// The declared minimum, the compact-window smoke size, and the two shapes that
// had no rules at all before this work: a wide, short letterbox and a narrow,
// tall portrait slice.
const SIZES = (process.argv[4] || "340x400,480x600,720x560,1100x700,1400x420,1600x900,360x900,2560x1440")
  .split(",")
  .map((entry) => {
    const [width, height] = entry.split("x").map(Number);
    return { label: entry, width, height };
  });

// A snapshot with every section populated, so each view has something to lay
// out. The shapes mirror what the backend really returns.
const FILES = [
  { id: 1, group: "staged", status: "M", staged: true, path: "app/src/style/tokens.css", originPath: null, conflict: false },
  { id: 2, group: "staged", status: "A", staged: true, path: "app/tests/layout-probe.mjs", originPath: null, conflict: false },
  { id: 3, group: "worktree", status: "M", staged: false, path: "app/src-tauri/src/main.rs", originPath: null, conflict: false },
  { id: 4, group: "worktree", status: "R", staged: false, path: "app/src/views/history.ts", originPath: "app/src/views/old-history.ts", conflict: false },
  { id: 5, group: "worktree", status: "UU", staged: false, path: "app/src/state.ts", originPath: null, conflict: true },
  { id: 6, group: "untracked", status: "??", staged: false, path: "tools/bench/color-contrast.py", originPath: null, conflict: false },
];

const COMMITS = Array.from({ length: 60 }, (_, index) => ({
  oid: String(index).padStart(40, "0"),
  subject: index === 0 ? "keep focus out of the closed dialog when the trigger is rebuilt" : `commit subject line number ${index}`,
  authorName: "player-Muteki",
  authorDate: "2026-09-26T12:00:00+08:00",
  refs: index === 0 ? ["HEAD -> master", "origin/master"] : [],
  body: index === 0 ? "A longer body that explains the change in a sentence or two." : "",
}));

// The stub: every command the shell can call at boot, with a payload shaped
// like the real one. Anything unknown resolves to null so a new command does
// not hang the probe.
const STUB = `
window.__SNAPSHOT__ = __PAYLOAD__.snapshot;
window.__REFS__ = __PAYLOAD__.refs;
window.__FILES__ = __PAYLOAD__.files;
window.__COMMITS__ = __PAYLOAD__.commits;
window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    const A = args || {};
    const table = {
      restore_repository: () => window.__SNAPSHOT__,
      refresh_repository: () => window.__SNAPSHOT__,
      list_recent_repositories: () => ["/home/dev/project", "/home/dev/wt/feature-macaron"],
      load_window_settings: () => null,
      list_refs: () => window.__REFS__,
      list_branches: () => window.__REFS__.branches,
      list_tags: () => window.__REFS__.tags,
      list_remotes: () => window.__REFS__.remotes,
      pull_default: () => "rebase",
      list_worktrees: () => window.__REFS__.worktrees,
      submodule_status: () => window.__REFS__.submodules,
      stash_list: () => window.__REFS__.stash,
      history_page: () => ({ commits: window.__COMMITS__, hasMore: true }),
      commit_files: () => ({ files: window.__FILES__.slice(0, 3) }),
      probe_git: () => ({ version: "2.53.0", ok: true }),
      probe_external_tools: () => ({ difftool: "meld", mergetool: "meld", opener: "xdg-open" }),
      diagnostics_summary: () => ({ events: [], files: [] }),
      set_always_on_top: () => null,
      save_window_settings: () => null,
    };
    if (Object.prototype.hasOwnProperty.call(table, cmd)) return Promise.resolve(table[cmd](A));
    return Promise.resolve(null);
  },
  transformCallback: (cb) => { const id = Math.random().toString(36).slice(2); window["_" + id] = cb; return id; },
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};
window.__TAURI__ = { event: { listen: () => Promise.resolve(() => {}) } };
`;

const SNAPSHOT = {
  version: 3,
  repository: { root: "/home/dev/project", bare: false },
  branch: { name: "master", oid: "bb655b5b0a9569eabec926ae08104a1e39104612", upstream: "origin/master" },
  counts: { staged: 2, unstaged: 3, untracked: 1, conflicts: 1 },
  files: FILES,
  inflight: [{ kind: "merge", message: "Merging feature/macaron into master" }],
};

const REFS = {
  branches: [
    { name: "master", current: true, oid: "bb655b5", upstream: "origin/master", ahead: 2, behind: 0, remote: "origin" },
    { name: "feature/macaron-tokens-and-responsive-geometry", current: false, oid: "961eebc", upstream: null, ahead: 0, behind: 0, remote: null },
  ],
  tags: [{ name: "v0.1.0", target: "bb655b5", annotated: true }],
  remotes: [
    { name: "origin", url: "https://github.com/player-Muteki/guit.git", kind: "fetch", branches: 12 },
    { name: "gitee", url: "git@gitee.com:mirrors/git.git", kind: "both", branches: 3 },
  ],
  worktrees: [
    { path: "/home/dev/project", branch: "master", locked: false, prunable: false },
    { path: "/home/dev/wt/feature-macaron-responsive", branch: "feature/macaron", locked: false, prunable: false },
  ],
  submodules: [{ path: "vendor/lib", name: "lib", state: "in sync", oid: "d38352c", described: "vendor/lib (heads/main)" }],
  stash: [{ index: 0, message: "WIP on master: macaron tokens", branch: "master" }],
};


import { createServer } from "node:http";
import { request } from "node:http";
import { connect as netConnect } from "node:net";

// A newer DevTools answers /json/new with 405 unless the request is a PUT, so
// the method is part of the call rather than a detail.
const httpGet = (url, method = "GET") => new Promise((resolvePromise, rejectPromise) => {
  request(url, { method }, (response) => {
    let body = "";
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => resolvePromise(JSON.parse(body)));
  }).on("error", rejectPromise).end();
});

// A websocket client just large enough for CDP: a handshake, then masked text
// frames out and unmasked frames in. Nothing is installed for this — the
// browser ships the protocol, `ws` is not in the tree, and a probe that needs a
// dependency installed is a probe nobody ends up running.
function openSocket(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(url);
    const key = Buffer.from(Math.random().toString(36)).toString("base64").slice(0, 22) + "==";
    const socket = netConnect(Number(target.port), target.hostname, () => {
      socket.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
        `Host: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });

    const listeners = [];
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();

    const send = (text) => {
      const payload = Buffer.from(text);
      const mask = Buffer.from([1, 2, 3, 4]);
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        const size = Buffer.alloc(2);
        size.writeUInt16BE(payload.length);
        header = Buffer.concat([Buffer.from([0x81, 0x80 | 126]), size]);
      } else {
        const size = Buffer.alloc(8);
        size.writeBigUInt64BE(BigInt(payload.length));
        header = Buffer.concat([Buffer.from([0x81, 0x80 | 127]), size]);
      }
      const masked = Buffer.alloc(payload.length);
      for (let index = 0; index < payload.length; index += 1) {
        masked[index] = payload[index] ^ mask[index % 4];
      }
      socket.write(Buffer.concat([header, mask, masked]));
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        buffer = buffer.subarray(end + 4);
        handshakeDone = true;
        resolvePromise({
          // A reply that never arrives has to surface as a failure, not as a
          // probe that hangs until someone notices: a gate nobody can fail is
          // not a gate.
          call: (method, params) => new Promise((res, rej) => {
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error("CDP timed out waiting for " + method));
            }, 25000);
            pending.set(id, {
              res: (value) => { clearTimeout(timer); res(value); },
              rej: (error) => { clearTimeout(timer); rej(error); },
            });
            send(JSON.stringify({ id, method, params }));
          }),
          close: () => socket.destroy(),
        });
      }
      while (handshakeDone && buffer.length >= 2) {
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
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        for (const handler of listeners) handler(payload);
      }
    });
    socket.on("error", rejectPromise);
    socket.on("close", () => {
      for (const entry of pending.values()) entry.rej(new Error("the devtools socket closed"));
    });
    listeners.push((payload) => {
      const message = JSON.parse(payload.toString());
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.rej(new Error(JSON.stringify(message.error)));
      else entry.res(message.result);
    });
  });
}

// --- the in-page measurement -------------------------------------------
// It runs inside the page so it reads real getBoundingClientRect values and the
// *resolved* custom properties: the only way to know what a breakpoint actually
// did, rather than what it was asked to do.
const MEASURE = `(() => {
  const px = (value) => parseFloat(value) || 0;
  const style = getComputedStyle(document.documentElement);
  const tokens = {};
  for (const name of ["--surface-app", "--surface-panel", "--accent", "--text",
                      "--appbar-height", "--statusbar-height", "--rail-width",
                      "--gutter", "--detail-cap", "--list-cap"]) {
    tokens[name] = style.getPropertyValue(name).trim();
  }
  const root = document.querySelector(".shell") || document.body;
  const view = document.querySelector(".view:not([hidden])");
  const bounds = (node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, w: box.width, h: box.height, right: box.right, bottom: box.bottom };
  };
  // Visibility has to be judged against the whole ancestor chain, not just the
  // node: a hidden welcome view still hands its children non-zero boxes, and
  // reporting those as "text painted on the status bar" is a false defect on
  // every view at every size.
  const isVisible = (node) => {
    for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
      if (current.hasAttribute && current.hasAttribute("hidden")) return false;
      const computed = getComputedStyle(current);
      if (computed.display === "none" || computed.visibility === "hidden") return false;
      if (Number(computed.opacity) === 0) return false;
    }
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  // Every element that renders text of its own (not inherited from a child).
  const textNodes = Array.from(root.querySelectorAll("*")).filter((node) => {
    if (!isVisible(node)) return false;
    return Array.from(node.childNodes)
      .filter((child) => child.nodeType === 3)
      .map((child) => child.textContent.trim())
      .join("").length > 0;
  }).map((node) => {
    const box = bounds(node);
    const computed = getComputedStyle(node);
    return Object.assign({
      tag: node.tagName.toLowerCase(),
      cls: (node.className && String(node.className).slice(0, 36)) || "",
      text: (node.textContent || "").trim().slice(0, 28),
      fontSize: px(computed.fontSize),
      lineHeight: px(computed.lineHeight) || px(computed.fontSize) * 1.2,
    }, box, { overflowsRight: box.right > window.innerWidth + 1 });
  });
  // Present and reported as shown, but with a box too small to draw the text
  // it holds: shorter than one line, or narrower than a single character.
  const invisible = textNodes
    .filter((node) => !node.cls.includes("virtual"))
    .filter((node) => node.h + 1 < node.lineHeight || node.w + 1 < node.fontSize)
    .map((node) => node.cls + ' ["' + node.text + '"]');
  // Two text boxes that intersect by more than a sliver.
  const overlaps = [];
  for (let i = 0; i < textNodes.length; i += 1) {
    for (let j = i + 1; j < textNodes.length; j += 1) {
      const a = textNodes[i];
      const b = textNodes[j];
      if (a.cls.includes("virtual") || b.cls.includes("virtual")) continue;
      const ox = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      if (ox > 2 && oy > 2) {
        overlaps.push(a.cls + " [" + a.text + "] x " + b.cls + " [" + b.text + "]");
      }
    }
  }
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    rootFontSize: style.fontSize,
    tokens: tokens,
    // offsetHeight, not getBoundingClientRect: the former is a layout pixel in
    // CSS units and the latter is a visual pixel, so only the first can be
    // divided by a computed font-size to recover a rem length.
    appbarPx: document.querySelector(".appbar")
      ? document.querySelector(".appbar").offsetHeight : null,
    docScrollX: document.documentElement.scrollWidth > window.innerWidth + 1,
    docScrollY: document.documentElement.scrollHeight > window.innerHeight + 1,
    shell: bounds(root),
    view: view ? bounds(view) : null,
    overflow: textNodes.filter((n) => n.overflowsRight)
      .map((n) => n.cls + " [" + n.text + "] right=" + Math.round(n.right)),
    invisible: invisible,
    overlaps: overlaps,
    textCount: textNodes.length,
  };
})()`;

// --- drive it -----------------------------------------------------------



// The bundle is an ES module that imports `@tauri-apps/api`, so it has to be
// fetched over http with a real origin; inlining it into a data: URL would
// fail module resolution and tell us nothing about layout.
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serve(root) {
  return new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      const path = new URL(request.url, "http://x").pathname;
      let body;
      try {
        body = readFileSync(join(root, path === "/" ? "index.html" : path));
      } catch {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      const extension = path.slice(path.lastIndexOf("."));
      response.writeHead(200, { "content-type": MIME[extension] || "application/octet-stream" });
      response.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({ origin: "http://127.0.0.1:" + port, close: () => server.close() });
    });
  });
}

const VIEWS = ["Changes", "History", "Branches & Tags", "Stash", "Remotes",
               "Worktrees & Submodules", "Settings"];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const asset = readdirSync(join(DIST, "assets")).find((name) => name.endsWith(".js"));
  if (!asset) throw new Error("no built bundle in " + DIST);
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  // The stub is installed before any document script runs, so it is a
  // document-start script rather than something injected after load.
  const server = await serve(DIST);

  const fails = [];
  const check = (label, ok, detail) => {
    console.log((ok ? "ok:   " : "FAIL: ") + label + (detail ? "  [" + detail + "]" : ""));
    if (!ok) fails.push(label);
  };

  const stub = "const __PAYLOAD__ = " + JSON.stringify({
    snapshot: SNAPSHOT, refs: REFS, files: FILES, commits: COMMITS,
  }) + ";\n" + STUB;

  // One target per size. A target that has already been emulated caches the
  // media-query evaluation, and reusing it is what made a tall window inherit
  // the previous short window's compact chrome. A fresh target per size makes
  // the whole class of bug impossible.
  let session = null;
  const evaluate = async (expression) => {
    const result = await session.call("Runtime.evaluate", {
      expression: expression, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
    }
    return result.result.value;
  };

  for (const size of SIZES) {
    if (session) session.close();
    const target = await httpGet(CDP + "/json/new?about:blank", "PUT");
    session = await openSocket(target.webSocketDebuggerUrl);
    await session.call("Runtime.enable");
    await session.call("Page.enable");
    await session.call("Page.addScriptToEvaluateOnNewDocument", { source: stub });
    await session.call("Emulation.setDeviceMetricsOverride", {
      width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
    });
    // A fresh document per size: the bundle reads the viewport at boot, and a
    // re-layout of a stale document would measure the wrong thing.
    // A cache-busted path, and a hard reload: navigating to the same document
    // with a different query string can be a same-document navigation, and the
    // media queries then keep evaluating against the *previous* size, so a tall
    // window inherits the previous short window's compact chrome.
    await session.call("Page.navigate", { url: server.origin + "/index.html?size=" + encodeURIComponent(size.label) });
    await sleep(1800);

    const booted = await evaluate(`!!document.querySelector(".shell")`);
    check(`[${size.label}] the shell boots`, booted === true);
    if (!booted) {
      const body = await evaluate(`document.body.innerText.slice(0,200)`);
      console.log("       body was: " + JSON.stringify(body));
      continue;
    }

    for (const view of VIEWS) {
      await evaluate(`(() => {
        const button = Array.from(document.querySelectorAll(".rail-item"))
          .find((node) => (node.getAttribute("aria-label") || "") === ${JSON.stringify(view)});
        if (button) button.click();
        return !!button;
      })()`);
      await sleep(500);
      const report = await evaluate(MEASURE);
      const where = `[${size.label}] ${view}`;

      check(`${where}: no text overlaps another`, report.overlaps.length === 0,
            report.overlaps.slice(0, 3).join(" | "));
      check(`${where}: nothing overflows the viewport`, report.overflow.length === 0,
            report.overflow.slice(0, 3).join(" | "));
      check(`${where}: no present-but-undrawable text`, report.invisible.length === 0,
            report.invisible.slice(0, 3).join(" | "));
      check(`${where}: no horizontal document scroll`, report.docScrollX === false);
      check(`${where}: content is actually laid out`, report.textCount > 0,
            report.textCount + " text nodes");
    }

    // The tokens the breakpoints exist to move: at a short window the chrome
    // must have shrunk, and that is only observable after the fact.
    const tokens = await evaluate(MEASURE);
    // Judged as a ratio against the root font, never as an absolute pixel
    // count: the renderer scales the whole document, and a px threshold then
    // measures the renderer's zoom rather than the breakpoint.
    const appbarRem = (tokens.appbarPx && tokens.rootFontSize)
      ? tokens.appbarPx / (parseFloat(tokens.rootFontSize) || 16) : null;
    // A token that is declared in the source, present in the bundle, and
    // still reads back empty is the signature of a rule that a *syntax* error
    // swallowed: a missing brace after an @media turns everything that follows
    // into a conditional block that does not match, so `var(--token)` resolves
    // to nothing and the element falls back to its content height. The source
    // and the built bundle both still contain the declaration, which is why
    // only a rendered check can see it.
    const cascade = await evaluate(`(() => {
      let rootRules = 0, hasMetric = false;
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const rule of rules) {
          if (rule.selectorText === ":root" &&
              rule.style.getPropertyValue("--appbar-height")) {
            rootRules++; hasMetric = true;
          }
        }
      }
      const root = document.documentElement;
      return { rootRules, hasMetric,
               token: getComputedStyle(root).getPropertyValue("--appbar-height").trim() };
    })()`);
    check(`[${size.label}] the metrics reach the rendered document`,
          cascade.rootRules > 0 && cascade.hasMetric && cascade.token !== "",
          `top-level :root rules=${cascade.rootRules}, --appbar-height="${cascade.token}"`);

    if (size.height <= 560) {
      check(`[${size.label}] a short window compacts the app bar`,
            appbarRem !== null && appbarRem <= 2.3,
            `app bar is ${appbarRem === null ? "?" : appbarRem.toFixed(2)}rem ` +
            `(base 2.5rem, 560px breakpoint 2.25rem, 440px breakpoint 2rem)`);
    } else {
      check(`[${size.label}] a roomy window keeps the full app bar`,
            appbarRem !== null && appbarRem > 2.4,
            `app bar is ${appbarRem === null ? "?" : appbarRem.toFixed(2)}rem (base 2.5rem)`);
    }

    // The macaron scheme must reach the running document, in both schemes.
    const light = await evaluate(`getComputedStyle(document.documentElement)
        .getPropertyValue("--surface-app").trim()`);
    check(`[${size.label}] the macaron surface is in effect`,
          light === "#fbf7f4" || light === "#1a1620", light);
  }

  if (session) session.close();
  server.close();
  console.log("\nfails=" + fails.length + (fails.length ? ": " + fails.join(", ") : ""));
  return fails.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(2);
});
