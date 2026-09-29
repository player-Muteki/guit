// Rendering gate for the guit shell: real layout, real sizes, real reach.
//
// The static gates (responsive-check.py) prove that a bare `vh` is gone and
// that both axes have a breakpoint. They cannot see the failure the layout
// notes record as real: a section squashed by a column flex container and
// painted on top of the next one, while every accessibility assertion still
// passed. That is a rendering fact, so it is checked in a renderer.
//
// The panel is two pages that share one tab strip, one layer the branch picker
// borrows, and a main page whose two regions are on screen together. The probe
// boots the built bundle against a stub IPC, then measures every screen the
// user can be on at every interesting shape. Three defects are asserted on each
// of them, and they are the three that produce invisible or unusable UI:
//
//   overlap   two nodes that both render text and whose boxes intersect
//   overflow  a node whose right edge leaves the viewport
//   invisible a node that is SHOWING, carries text, and has a box too small
//             to draw it in
//
// Then four facts that only a renderer can give:
//
//   together   the changes area and the graph both keep a box at every size,
//              and the panel scrolls rather than crush one of them
//   divider    the split between them is a focusable drag target with a real
//              height, not a hairline nobody can grab
//   reach      every primary action is focusable and carries its name in the
//              accessibility tree — including a tab whose visible label a
//              narrow window has dropped
//   keys       Ctrl/Cmd+1 and +2 move between the pages from a cold start, and
//              Escape leaves a layer with focus on the strip that stays
//
// Usage: node layout-probe.mjs [dist-dir] [port] [sizes]
//   e.g. node tools/bench/layout-probe.mjs app/dist 9222
//   (the path is read against the current directory; omitting it uses the
//   built bundle at app/dist, found from this script's own location)
//
// It needs a browser and a built bundle, so it lives here rather than beside
// the node:test unit tests: a file under tests/ is executed by
// `npm run test:fixture`, and that run has neither a browser nor a display.
// Launch one first:
//   msedge --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/guit-edge

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request } from "node:http";
import { connect as netConnect } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.argv[2] || join(here, "..", "..", "app", "dist"));
const PORT = Number(process.argv[3] || 9222);
const CDP = `http://127.0.0.1:${PORT}`;

// The declared minimum and the compact-window smoke size come first: the exit
// criterion is that a user can reach everything in both of them. Then the
// roomy shapes, the letterbox and the portrait slice that once had no rules.
const SIZES = (process.argv[4]
  || "340x400,420x640,480x600,600x480,720x560,1100x700,1400x420,1600x900,2560x1440")
  .split(",")
  .map((entry) => {
    const [width, height] = entry.split("x").map(Number);
    return { label: entry, width, height };
  });

// --- the payload, in the shape the backend publishes -----------------------

const fileView = (id, group, display, extra) => ({
  id,
  display,
  renameFrom: group === "renamed" ? "app/src/views/old-history.ts" : null,
  group,
  indexStatus: group === "staged" ? "M" : " ",
  worktreeStatus: group === "conflict" ? "U" : group === "worktree" ? "M" : " ",
  staged: group === "staged",
  unstaged: group === "worktree" || group === "renamed",
  conflict: group === "conflict",
  untracked: group === "untracked",
  submodule: false,
  ...extra,
});

// One row per group the changes area has, so each is laid out at least once.
const FILES = [
  fileView(1, "conflict", "src/state.ts"),
  fileView(2, "staged", "app/src/style/tokens.css"),
  fileView(3, "staged", "app/tests/layout-probe.mjs"),
  fileView(4, "worktree", "app/src-tauri/src/main.rs"),
  fileView(5, "renamed", "app/src/views/history.ts"),
  fileView(6, "untracked", "tools/bench/color-contrast.py"),
];

// The tab badge caps its count at "99+", and a cap is only tested by reaching
// it: the widest number the strip can show is the one that has to keep out of
// the word and out of the neighbouring tab.
const PENDING = Array.from({ length: 120 }, (_, index) =>
  fileView(100 + index, "worktree", `src/pending/a-file-with-a-long-name-${index}.ts`));

const commit = (index) => ({
  oid: String(index).padStart(40, "0"),
  parents: index === 0 ? ["bb655b5b0a9569eabec926ae08104a1e39104612"] : [String(index - 1).padStart(40, "0")],
  subject: index === 0
    ? "keep focus out of the closed dialog when the trigger is rebuilt"
    : `commit subject line number ${index}`,
  message: index === 0
    ? "keep focus out of the closed dialog when the trigger is rebuilt\n\nA longer body that explains the change in a sentence or two."
    : `commit subject line number ${index}`,
  authorName: "player-Muteki",
  authorEmail: "dev@example.com",
  authorDate: "2026-09-26T12:00:00+08:00",
  committerName: "player-Muteki",
  commitDate: "2026-09-26T12:00:00+08:00",
  refs: index === 0 ? ["HEAD -> master"] : [],
  labels: { branches: index === 0 ? ["master"] : [], tags: [], remotes: [], head: index === 0 },
  graph: index === 0
    ? { node: 0, entry: true, exit: false, merge: false, root: false, lanes: [], branches: [], incoming: [{ lane: 0, rows: 1 }], dangling: false, folded: false }
    : {
        node: 0,
        entry: index === 60,
        // The last row closes its lane, so nothing draws a line into no row.
        exit: index !== 60,
        merge: false,
        root: index === 60,
        lanes: [],
        branches: [],
        incoming: [],
        dangling: false,
        folded: false,
      },
});

// Enough rows to make a scrollbar exist at the small sizes, which is what the
// overlap and overflow checks need in order to have something to be wrong
// about. A graph of three commits never overflows anything, anywhere.
const COMMITS = Array.from({ length: 61 }, (_, index) => commit(index));

const BASE = {
  version: 1,
  // Minted by the backend, never derived from what Git reported.
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
    ahead: 2,
    behind: 1,
  },
  files: FILES,
  operation: { kind: "merge", subject: "Merging feature/macaron into master", step: 3, total: 7 },
};

const REFS = {
  branches: [
    { name: "master", current: true, oid: "bb655b5b", upstream: "origin/master", ahead: 2, behind: 1, remote: "origin", upstreamGone: false, addressable: true },
    { name: "feature/macaron-tokens-and-responsive-geometry", current: false, oid: "961eebc0", upstream: null, ahead: 0, behind: 0, remote: null, upstreamGone: false, addressable: true },
    { name: "release/with-a-somewhat-long-branch-name", current: false, oid: "1d2c3e4f", upstream: "origin/release", ahead: 11, behind: 4, remote: "origin", upstreamGone: false, addressable: true },
  ],
  remotes: [
    { name: "origin", url: "https://github.com/player-Muteki/guit.git", kind: "fetch", branches: 12 },
  ],
  tags: [{ name: "v0.1.0", target: "bb655b5b", annotated: true }],
};

// The stub. Bound reads answer the way the backend does — the value wrapped in
// the context that was asked with — because a reply that fails the panel's own
// check is dropped, and a probe whose payload is always dropped measures an
// empty document and calls it a pass.
const STUB = `(() => {
  window.__SNAPSHOT__ = ${JSON.stringify(BASE)};
  const REFS = ${JSON.stringify(REFS)};
  const COMMITS = ${JSON.stringify(COMMITS)};
  const PENDING = ${JSON.stringify(PENDING)};
  const ORIGINAL_FILES = ${JSON.stringify(BASE.files)};
  // Every session answer is a new object carrying a newer version. Handing back
  // the fixture's own object would let a change made to it look like the
  // snapshot the screen already holds: the shell keeps what it was given, so a
  // mutated field would arrive under the version it was already stored at, and
  // the panel would correctly refuse to move.
  let issued = 0;
  const session = () => Object.assign({}, window.__SNAPSHOT__, { version: ++issued });
  const table = {
    restore_repository: session,
    refresh_repository: session,
    open_repository: session,
    close_repository: () => null,
    list_recent_repositories: () => ["/home/dev/project", "/home/dev/wt/feature-macaron"],
    list_refs: (A) => ({ context: A.context, value: REFS }),
    history_page: (A) => ({ context: A.context, value: { commits: COMMITS, hasMore: true } }),
    // A commit's files fill the detail pane, so the pane the user reads under
    // the graph is measured with something in it rather than empty.
    commit_files: (A) => ({
      context: A.context,
      value: [
        { status: "M", path: "app/src/style/tokens.css", oldPath: null },
        { status: "A", path: "app/tests/layout-probe.mjs", oldPath: null },
        { status: "R", path: "app/src/views/history.ts", oldPath: "app/src/views/old-history.ts" },
      ],
    }),
    show_tag: (A) => ({ context: A.context, value: { name: "v0.1.0", oid: "bb655b5b", targetOid: "bb655b5b", annotated: true, message: "" } }),
    stash_list: (A) => ({ context: A.context, value: [] }),
    list_worktrees: (A) => ({ context: A.context, value: [] }),
    submodule_status: (A) => ({ context: A.context, value: [] }),
    probe_git: () => ({ available: true, version: "2.53.0", executable: "/usr/bin/git", supported: true, hasRestore: true, message: "" }),
    probe_external_tools: () => ({ difftool: "meld", mergetool: "meld", opener: "xdg-open" }),
    load_window_settings: () => null,
    save_window_settings: () => null,
    restore_window_settings: () => null,
  };
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      const A = args || {};
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
  // Driving the shell the way a user does: the app bar's own buttons. A probe
  // that poked the store directly would measure a state the interface cannot
  // reach, which is the opposite of what a layout gate is for.
  window.__BAR__ = (label) => {
    const button = document.querySelector('.appbar [aria-label="' + label + '"]');
    if (button) button.click();
    return !!button;
  };
  window.__TAB__ = (label) => {
    const tab = document.querySelector('.tabs [aria-label="' + label + '"]');
    if (tab) tab.click();
    return !!tab;
  };
  // Reopening through the empty state's own row, so a Main that is measured
  // again after a closed session is measured the way a user comes back to it.
  window.__REOPEN__ = () => {
    const row = document.querySelector(".recent-list button");
    if (row) row.click();
    return !!row;
  };
  // A working tree wider than the badge can count. Passing null hands back the
  // fixture's own rows, so a check that widens the count does not leave every
  // later screen measured against a repository the fixture never described. The
  // refresh goes through the app bar's own button, because that is the only way
  // a snapshot reaches the shell.
  window.__PENDING__ = (count) => {
    window.__SNAPSHOT__.files = count === null ? ORIGINAL_FILES : PENDING.slice(0, count);
    window.__BAR__("Refresh status");
  };
  window.__KEY__ = (key) => {
    // From the body, not from window: a window-targeted event never walks
    // through the document, and the layer's Escape lives there.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: key, ctrlKey: true, bubbles: true, cancelable: true }));
  };
})();`;

// --- the in-page measurement ----------------------------------------------
// It runs inside the page so it reads real getBoundingClientRect values and the
// *resolved* custom properties: the only way to know what a breakpoint actually
// did, rather than what it was asked to do.
const MEASURE = `(() => {
  const px = (value) => parseFloat(value) || 0;
  const style = getComputedStyle(document.documentElement);
  const tokens = {};
  for (const name of ["--surface-app", "--surface-panel", "--accent", "--text",
                      "--appbar-height", "--statusbar-height", "--tab-min-width",
                      "--tab-item-size", "--splitter-size", "--main-split",
                      "--gutter", "--detail-cap", "--list-cap"]) {
    tokens[name] = style.getPropertyValue(name).trim();
  }
  const root = document.querySelector(".shell") || document.body;
  const view = document.querySelector(".view:not([hidden])");
  const bounds = (node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, w: box.width, h: box.height, right: box.right, bottom: box.bottom };
  };
  // A box is only painted as far as every clipping ancestor lets it through.
  // A virtual list lays its rows out across a box as tall as the whole list and
  // clips them with its own scroller, so the raw rects of the rows below the
  // fold land on top of whatever the next region draws — a hundred overlaps no
  // user ever sees, and the reason this is measured against the painted rect.
  const painted = (node) => {
    const box = node.getBoundingClientRect();
    let left = box.left, top = box.top, right = box.right, bottom = box.bottom;
    for (let current = node.parentElement; current && current !== document.documentElement; current = current.parentElement) {
      const computed = getComputedStyle(current);
      if (computed.overflowX === "visible" && computed.overflowY === "visible") continue;
      const clip = current.getBoundingClientRect();
      left = Math.max(left, clip.left + px(computed.borderLeftWidth));
      top = Math.max(top, clip.top + px(computed.borderTopWidth));
      right = Math.min(right, clip.right - px(computed.borderRightWidth));
      bottom = Math.min(bottom, clip.bottom - px(computed.borderBottomWidth));
    }
    return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top), right: right, bottom: bottom };
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
  // The one page-sized layer the branch picker borrows is opaque and covers
  // the stage, so what is behind it is not painted and cannot be mislaid: it is
  // measured against the layer's own contents, and what sits under it is left
  // out rather than reported as a hundred overlaps.
  const layer = document.querySelector(".overlay:not([hidden])");
  const layerBox = layer ? layer.getBoundingClientRect() : null;
  const layerPaint = layer ? getComputedStyle(layer) : null;
  const covers = (node) => {
    if (layerBox === null) return false;
    if (layer.contains(node)) return false;
    const stage = document.querySelector(".stage");
    if (!stage || !stage.contains(node)) return false;
    const box = node.getBoundingClientRect();
    return box.right > layerBox.left && box.left < layerBox.right
      && box.bottom > layerBox.top && box.top < layerBox.bottom;
  };
  const textNodes = Array.from(root.querySelectorAll("*")).filter((node) => {
    if (!isVisible(node)) return false;
    return Array.from(node.childNodes)
      .filter((child) => child.nodeType === 3)
      .map((child) => child.textContent.trim())
      .join("").length > 0;
  }).map((node) => {
    const box = painted(node);
    // Clipped away entirely: it paints nothing, so it can neither collide with
    // a neighbour nor be reported as unreadable.
    if (box.w <= 0 || box.h <= 0) return null;
    const computed = getComputedStyle(node);
    const own = bounds(node);
    return Object.assign({
      tag: node.tagName.toLowerCase(),
      cls: (node.className && String(node.className).slice(0, 36)) || "",
      text: (node.textContent || "").trim().slice(0, 28),
      fontSize: px(computed.fontSize),
      lineHeight: px(computed.lineHeight) || px(computed.fontSize) * 1.2,
      hidden: covers(node),
      // The undrawable question is about the box the layout gave the text, not
      // the part of it the scroll window happens to show: a row half past the
      // bottom of a list is scrolled to, not broken.
      rawW: own.w,
      rawH: own.h,
    }, box, { overflowsRight: box.right > window.innerWidth + 1 });
  }).filter(Boolean);
  const drawn = textNodes.filter((node) => !node.hidden);
  // Given a box, present as shown, but too small for its own glyphs: shorter
  // than the font it draws, or narrower than even one narrow character. Line
  // height is deliberately not the bar — a chip sized to its glyph box is
  // shorter than its line and reads fine, and a mono chevron is under 1em wide.
  const invisible = drawn
    .filter((node) => !node.cls.includes("virtual"))
    .filter((node) => node.rawH < node.fontSize || node.rawW < node.fontSize * 0.45)
    .map((node) => node.tag + "." + (node.cls || "-") + ' ["' + node.text + '"] '
      + Math.round(node.rawW) + "x" + Math.round(node.rawH)
      + " font=" + Math.round(node.fontSize * 10) / 10
      + " line=" + Math.round(node.lineHeight * 10) / 10);
  // Two text boxes that intersect by more than a sliver.
  const overlaps = [];
  for (let i = 0; i < drawn.length; i += 1) {
    for (let j = i + 1; j < drawn.length; j += 1) {
      const a = drawn[i];
      const b = drawn[j];
      if (a.cls.includes("virtual") || b.cls.includes("virtual")) continue;
      const ox = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      if (ox > 2 && oy > 2) {
        overlaps.push(a.cls + " [" + a.text + "] x " + b.cls + " [" + b.text + "]");
      }
    }
  }
  const probe = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const computed = getComputedStyle(node);
    return Object.assign(bounds(node), {
      display: computed.display,
      hidden: node.hidden === true,
      minHeight: px(computed.minHeight),
      canScroll: node.scrollHeight > node.clientHeight + 1,
      rows: node.querySelectorAll("*").length,
    });
  };
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
    overflow: drawn.filter((n) => n.overflowsRight)
      .map((n) => n.cls + " [" + n.text + "] right=" + Math.round(n.right)),
    invisible: invisible,
    overlaps: overlaps,
    textCount: drawn.length,
    coveredCount: textNodes.length - drawn.length,
    tabs: {
      count: document.querySelectorAll(".tabs .tab-item").length,
      current: Array.from(document.querySelectorAll(".tabs .tab-item"))
        .filter((n) => n.getAttribute("aria-current") === "page")
        .map((n) => n.getAttribute("aria-label")),
      // A narrow window hides the words but the buttons keep their accessible
      // name; this is what says which of the two the renderer actually did.
      labelled: Array.from(document.querySelectorAll(".tabs .tab-item"))
        .map((n) => ({
          name: n.getAttribute("aria-label"),
          wordsVisible: (() => {
            const label = n.querySelector(".tab-label");
            return !!label && getComputedStyle(label).display !== "none";
          })(),
        })),
    },
    regions: {
      panel: probe(".main-panel"),
      changes: probe(".main-panel > .changes-view"),
      history: probe(".main-panel > .history-view"),
      fileList: probe(".main-panel > .changes-view .file-list"),
      historyList: probe(".main-panel > .history-view .history-list"),
      splitter: probe(".main-splitter"),
    },
    overlay: (() => {
      if (!layer) return { open: false };
      const stage = document.querySelector(".stage");
      const stageBox = stage ? bounds(stage) : null;
      const background = layerPaint.backgroundColor;
      return {
        open: true,
        box: bounds(layer),
        background: background,
        // A layer that is only partly transparent over a live panel is a layer
        // the user reads *through*, so "covered" is a claim about its paint,
        // not about its z-index.
        opaque: background !== "" && background !== "transparent" && background.indexOf("rgba(") !== 0,
        coversStage: stageBox !== null
          && layerBox.left <= stageBox.x + 1 && layerBox.right >= stageBox.right - 1
          && layerBox.top <= stageBox.y + 1 && layerBox.bottom >= stageBox.bottom - 1,
        coveredCount: textNodes.length - drawn.length,
      };
    })(),
    focused: (() => {
      const node = document.activeElement;
      if (!node || node === document.body) return null;
      return {
        tag: node.tagName.toLowerCase(),
        cls: String(node.className || "").slice(0, 40),
        name: node.getAttribute("aria-label") || (node.textContent || "").trim().slice(0, 30),
      };
    })(),
  };
})()`;

// Every action a user needs, by the name the interface gives it. A control
// missing here is a control the harness cannot reach either, which is the same
// failure the AT-SPI smoke used to look for in the real window. Regions count
// too: a list a user has to find is named the same way a button is.
const NAMES = `(() => {
  const isVisible = (node) => {
    for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
      if (current.hasAttribute && current.hasAttribute("hidden")) return false;
      const computed = getComputedStyle(current);
      if (computed.display === "none" || computed.visibility === "hidden") return false;
    }
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const out = [];
  for (const node of document.querySelectorAll("[aria-label], button, input, select, textarea, [tabindex]")) {
    if (!isVisible(node)) continue;
    const tag = node.tagName.toLowerCase();
    const isControl = tag === "button" || tag === "input" || tag === "select" || tag === "textarea";
    out.push({
      name: node.getAttribute("aria-label") || (node.textContent || "").trim().slice(0, 40),
      control: isControl,
      // A disabled control is on screen but is not an action, so it cannot
      // stand in for the one this probe is asking about.
      blocked: isControl && (node.disabled === true || node.tabIndex < 0),
    });
  }
  return out;
})()`;

const PAGES = {
  Main: ["Main", "Settings", "Open repository", "Refresh status", "More repository actions",
         "Switch branch", "Changed files", "Commit message", "Commit history"],
  // The layer is a third thing on the page, and it is the only screen with
  // these controls.
  Picker: ["Filter branches and tags", "New branch name", "Branches and tags"],
  Settings: ["Main", "Settings", "Theme", "Zoom in", "Zoom out", "Reset zoom",
             "Test compact window", "Export diagnostics…", "Run probe"],
  Welcome: ["Main", "Settings", "Open repository", "Recent repositories"],
};

// --- drive it -------------------------------------------------------------

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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const asset = readdirSync(join(DIST, "assets")).find((name) => name.endsWith(".js"));
  if (!asset) throw new Error("no built bundle in " + DIST);
  const server = await serve(DIST);

  const fails = [];
  const check = (label, ok, detail) => {
    console.log((ok ? "ok:   " : "FAIL: ") + label + (detail ? "  [" + detail + "]" : ""));
    if (!ok) fails.push(label);
  };

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

  // A screen is a place the panel can be asked to be, reached only through the
  // controls a user has: a tab, the branch chip, the app bar's close button. A
  // probe that wrote into the store directly would measure a state the
  // interface cannot arrive at, which is the opposite of what this is for.
  const SCREENS = [
    { key: "Main", enter: 'window.__TAB__("Main")' },
    { key: "Picker", enter: 'window.__TAB__("Main"); document.querySelector(".appbar-branch").click()' },
    { key: "Settings", enter: 'window.__TAB__("Settings")' },
    { key: "Welcome", enter: 'window.__TAB__("Main"); window.__BAR__("Close session")' },
  ];

  for (const size of SIZES) {
    if (session) session.close();
    const target = await httpGet(CDP + "/json/new?about:blank", "PUT");
    session = await openSocket(target.webSocketDebuggerUrl);
    await session.call("Runtime.enable");
    await session.call("Page.enable");
    await session.call("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
    await session.call("Emulation.setDeviceMetricsOverride", {
      width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
    });
    // A cache-busted navigation: going to the same document with a different
    // query string can be a same-document navigation, and the media queries
    // then keep evaluating against the *previous* size, so a tall window
    // inherits the previous short window's compact chrome.
    await session.call("Page.navigate", { url: server.origin + "/index.html?size=" + encodeURIComponent(size.label) });
    await sleep(1800);

    const booted = await evaluate(`!!document.querySelector(".shell")`);
    check(`[${size.label}] the shell boots`, booted === true);
    if (!booted) {
      const body = await evaluate(`document.body.innerText.slice(0,200)`);
      console.log("       body was: " + JSON.stringify(body));
      continue;
    }

    const strip = await evaluate(`(() => ({
      count: document.querySelectorAll(".tabs .tab-item").length,
      names: Array.from(document.querySelectorAll(".tabs .tab-item"))
        .map((n) => n.getAttribute("aria-label")).join(","),
    }))()`);
    check(`[${size.label}] exactly two pages hang off the strip`,
          strip.count === 2 && strip.names === "Main,Settings", strip.names);

    for (const screen of SCREENS) {
      await evaluate(screen.enter);
      await sleep(500);
      const report = await evaluate(MEASURE);
      const where = `[${size.label}] ${screen.key}`;

      check(`${where}: no text overlaps another`, report.overlaps.length === 0,
            report.overlaps.slice(0, 3).join(" | "));
      check(`${where}: nothing overflows the viewport`, report.overflow.length === 0,
            report.overflow.slice(0, 3).join(" | "));
      check(`${where}: no present-but-undrawable text`, report.invisible.length === 0,
            report.invisible.slice(0, 3).join(" | "));
      check(`${where}: no horizontal document scroll`, report.docScrollX === false);
      check(`${where}: content is actually laid out`, report.textCount > 0,
            report.textCount + " text nodes");
      check(`${where}: one page is the page on screen`, report.tabs.current.length === 1,
            report.tabs.current.join(","));

      // The screen's own reason to exist, measured rather than assumed.
      if (screen.key === "Picker") {
        const o = report.overlay;
        check(`${where}: the layer covers the panel opaquely rather than pushing it`,
              o.open === true && o.coversStage === true && o.opaque === true && o.coveredCount > 0,
              "covered=" + (o.coveredCount || 0) + " background=" + o.background);
      }
      if (screen.key === "Welcome") {
        check(`${where}: the empty state is Main's, not a third page`,
              report.tabs.current[0] === "Main" && report.textCount > 0);
      }

      const actions = await evaluate(NAMES);
      const onScreen = new Set(actions.filter((entry) => !entry.blocked).map((entry) => entry.name));
      const missing = (PAGES[screen.key] || []).filter((name) => !onScreen.has(name));
      check(`${where}: every action it offers is reachable`, missing.length === 0,
            missing.join(", "));
    }

    // --- the two regions of Main, together ---
    // Back through the empty state's own row: what is measured below is a panel
    // the user has returned to, not a store somebody poked.
    const reopened = await evaluate('window.__TAB__("Main"); window.__REOPEN__()');
    await sleep(700);
    check(`[${size.label}] the repository reopens from the empty state`, reopened === true);
    const geo = await evaluate(MEASURE);
    const r = geo.regions;
    const bothUp = r.changes && r.history && r.fileList && r.historyList
      && r.changes.h > 0 && r.history.h > 0
      && r.fileList.h > 0 && r.historyList.h > 0;
    check(`[${size.label}] the changes area and the graph are on screen together`, bothUp,
          r.changes && r.history
            ? `changes ${Math.round(r.changes.h)}px, history ${Math.round(r.history.h)}px`
            : "a region is missing");
    const floorsKept = r.changes && r.history
      && r.changes.h + 1 >= r.changes.minHeight
      && r.history.h + 1 >= r.history.minHeight;
    check(`[${size.label}] neither region is dragged under its own floor`, floorsKept,
          r.changes && r.history
            ? `changes ${Math.round(r.changes.h)}/${Math.round(r.changes.minHeight)}, ` +
              `history ${Math.round(r.history.h)}/${Math.round(r.history.minHeight)}`
            : "");
    const bothInside = r.panel && r.changes && r.history
      && r.history.bottom <= r.panel.y + r.panel.h + 1;
    check(`[${size.label}] a panel too short for both floors scrolls rather than clips`,
          r.panel && (bothInside || r.panel.canScroll),
          r.panel ? `panel ${Math.round(r.panel.h)}px scrollable=${r.panel.canScroll}` : "");

    const splitterFloor = parseFloat(geo.tokens["--splitter-size"]) || 0;
    check(`[${size.label}] the divider is a grabbable bar`,
          r.splitter !== null && r.splitter.h + 0.5 >= splitterFloor,
          r.splitter ? `divider ${Math.round(r.splitter.h * 10) / 10}px, --splitter-size ${splitterFloor}px` : "no divider");
    const grabbed = await evaluate(`(() => {
      const bar = document.querySelector(".main-splitter");
      if (!bar) return "absent";
      bar.focus();
      return document.activeElement === bar ? "focused" : "refused";
    })()`);
    check(`[${size.label}] the divider takes focus`, grabbed === "focused", grabbed);
    const moved = await evaluate(`(() => {
      const bar = document.querySelector(".main-splitter");
      if (!bar) return ["absent", "absent"];
      const read = () => bar.getAttribute("aria-valuenow");
      // Home first: the split the last window left in storage is not a floor
      // this window can claim, so the step is only meaningful from a place both
      // the bar and the check agree on.
      bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
      const floor = read();
      bar.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      return [floor, read()];
    })()`);
    check(`[${size.label}] the arrow keys move the split from the keyboard`,
          moved[0] !== moved[1] && moved[1] !== null, moved.join(" -> "));

    // "Restore window size" only becomes an action once a geometry change is on
    // record, which no browser session makes. It still has to be on the page,
    // or the control is unreachable at the one moment it is needed.
    const restore = await evaluate(`(() => {
      window.__TAB__("Settings");
      const found = Array.from(document.querySelectorAll("button"))
        .find((node) => (node.textContent || "").trim() === "Restore window size");
      return found ? { present: true, disabled: found.disabled === true } : { present: false };
    })()`);
    await sleep(300);
    check(`[${size.label}] the window restore sits on Settings`,
          restore.present === true, JSON.stringify(restore));

    // --- the keyboard, and where focus lands ---
    await evaluate('window.__KEY__("2")');
    await sleep(250);
    await evaluate('window.__KEY__("1")');
    await sleep(250);
    const pagesByKeys = await evaluate(`(() => ({
      main: document.querySelector('.tabs [aria-label="Main"]').getAttribute("aria-current"),
      settings: document.querySelector('.tabs [aria-label="Settings"]').getAttribute("aria-current"),
    }))()`);
    check(`[${size.label}] Ctrl/Cmd+1 and +2 answer from either page`,
          pagesByKeys.main === "page" && pagesByKeys.settings === "false",
          `main=${pagesByKeys.main} settings=${pagesByKeys.settings}`);

    const layer = await evaluate(`(() => {
      document.querySelector(".appbar-branch").click();
      const opened = !document.querySelector(".overlay").hidden;
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return {
        opened: opened,
        closed: document.querySelector(".overlay").hidden === true,
        focusOnStrip: !!document.activeElement.closest(".tabs"),
        focusName: document.activeElement.getAttribute("aria-label"),
      };
    })()`);
    check(`[${size.label}] Escape closes the layer and leaves focus on the strip`,
          layer.opened === true && layer.closed === true && layer.focusOnStrip === true,
          JSON.stringify(layer));

    // A narrow window may drop the words, but then the accessible name is the
    // only thing telling a user which tab they are on.
    if (size.width <= 560) {
      const tabs = (await evaluate(MEASURE)).tabs;
      check(`[${size.label}] a strip without its words still has its names`,
            tabs.labelled.some((t) => t.wordsVisible === false)
            && tabs.labelled.every((t) => !!t.name),
            JSON.stringify(tabs.labelled));
    }

    // --- the pending count, at the widest it is ever allowed to be ---
    // The badge is the only part of the strip that grows with the repository,
    // and it is capped at "99+" — a cap no single-digit fixture reaches. Two
    // things follow from that width and neither is visible below the cap: the
    // count must keep out of its tab's word, and it must not sit on the other
    // page's control, which is how a user leaves this one.
    await evaluate('window.__PENDING__(120)');
    await sleep(400);
    const counted = await evaluate(`(() => {
      const mark = document.querySelector(".tab-badge");
      if (!mark || mark.hidden) return null;
      const box = mark.getBoundingClientRect();
      const shown = (node) => node !== null && getComputedStyle(node).display !== "none";
      const word = document.querySelector('.tabs [aria-label="Main"] .tab-label');
      const other = document.querySelector('.tabs [aria-label="Settings"]');
      // The other tab's content, not its box: the corner a count is meant to
      // hang on is padding, and padding hides nothing.
      let inner = null;
      for (const child of Array.from(other.children)) {
        if (!shown(child)) continue;
        const r = child.getBoundingClientRect();
        if (r.width === 0) continue;
        inner = inner
          ? { left: Math.min(inner.left, r.left), right: Math.max(inner.right, r.right),
              top: Math.min(inner.top, r.top), bottom: Math.max(inner.bottom, r.bottom) }
          : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }
      const hit = (a, b) => a.right > b.left + 1 && b.right > a.left + 1
        && a.bottom > b.top + 1 && b.bottom > a.top + 1;
      return {
        text: (mark.textContent || "").trim(),
        overWord: shown(word) ? hit(box, word.getBoundingClientRect()) : "word hidden",
        overOtherTab: inner === null ? "no content" : hit(box, inner),
      };
    })()`);
    await evaluate('window.__PENDING__(null)');
    await sleep(300);
    check(`[${size.label}] the pending count reaches the cap it is measured at`,
          counted !== null && counted.text === "99+", JSON.stringify(counted));
    check(`[${size.label}] the widest count stays in its own gutter`,
          counted !== null && counted.overWord !== true && counted.overOtherTab === false,
          JSON.stringify(counted));

    // --- the accessibility tree, over the protocol the browser ships ---
    // This is what the AT-SPI smoke checks in the real window. The renderer
    // answers the same question for the bundle, so a name that only exists as
    // a DOM attribute — and therefore reaches no screen reader — fails here.
    let axNames = null;
    let axError = "";
    try {
      const ax = await session.call("Accessibility.getFullAXTree", {});
      axNames = new Set((ax.nodes || [])
        .filter((node) => node.ignored === false && node.name && node.name.value)
        .map((node) => node.name.value));
    } catch (error) {
      axError = String(error.message || error);
    }
    const axMissing = axNames === null ? [] : PAGES.Main.filter((name) => !axNames.has(name));
    check(`[${size.label}] the accessibility tree carries the primary actions`,
          axNames !== null && axMissing.length === 0,
          axError || axMissing.join(", "));

    // The tokens the breakpoints exist to move: at a short window the chrome
    // must have shrunk, and that is only observable after the fact.
    // Judged as a ratio against the root font, never as an absolute pixel
    // count: the renderer scales the whole document, and a px threshold then
    // measures the renderer's zoom rather than the breakpoint.
    const appbarRem = (geo.appbarPx && geo.rootFontSize)
      ? geo.appbarPx / (parseFloat(geo.rootFontSize) || 16) : null;
    // A token that is declared in the source, present in the bundle, and
    // still reads back empty is the signature of a rule that a *syntax* error
    // swallowed: a missing brace after an @media turns everything that follows
    // into a conditional block that does not match, so `var(--token)` resolves
    // to nothing and the element falls back to its content height.
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

    if (size.height <= 440) {
      check(`[${size.label}] a very short window compacts the app bar twice`,
            appbarRem !== null && appbarRem <= 2.05,
            `app bar is ${appbarRem === null ? "?" : appbarRem.toFixed(2)}rem (base 2.5rem, 440px breakpoint 2rem)`);
    } else if (size.height <= 560) {
      check(`[${size.label}] a short window compacts the app bar`,
            appbarRem !== null && appbarRem <= 2.3,
            `app bar is ${appbarRem === null ? "?" : appbarRem.toFixed(2)}rem (base 2.5rem, 560px breakpoint 2.25rem)`);
    } else {
      check(`[${size.label}] a roomy window keeps the full app bar`,
            appbarRem !== null && appbarRem > 2.4,
            `app bar is ${appbarRem === null ? "?" : appbarRem.toFixed(2)}rem (base 2.5rem)`);
    }

    // The macaron scheme must reach the running document, in both schemes.
    // Judged against the value the document itself declares for the token on a
    // top-level `:root` rule rather than a literal copied into this file: the
    // palette is allowed to move, and what a broken cascade loses is the rule
    // that paints it.
    const surface = await evaluate(`(() => {
      const declared = [];
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const rule of rules) {
          if (rule.selectorText && rule.selectorText.split(",").some((part) => part.trim() === ":root")) {
            const value = rule.style && rule.style.getPropertyValue("--surface-app");
            if (value) declared.push(value.trim());
          }
        }
      }
      return {
        declared: declared,
        used: getComputedStyle(document.documentElement).getPropertyValue("--surface-app").trim(),
      };
    })()`);
    check(`[${size.label}] the colour scheme reaches the rendered document`,
          surface.used !== "" && surface.declared.includes(surface.used),
          `--surface-app="${surface.used}" of [${surface.declared.join(",")}]`);
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