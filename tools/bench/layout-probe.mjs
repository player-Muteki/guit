// Rendering gate for the guit shell: real layout, real sizes, real reach.
//
// The static gates (responsive-check.py) prove that a bare `vh` is gone and
// that both axes have a breakpoint. They cannot see the failure the layout
// notes record as real: a section squashed by a column flex container and
// painted on top of the next one, while every accessibility assertion still
// passed. That is a rendering fact, so it is checked in a renderer.
//
// The panel is two pages that share one tab strip, two layers that float over
// the page (the branch picker borrows one page-sized, the search field draws its
// results into a shorter one), and a main page whose two regions are on screen
// together. The probe boots the built bundle against a stub IPC, then measures
// every screen the user can be on at every interesting shape. Three defects are
// asserted on each of them, and they are the three that produce invisible or
// unusable UI:
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
//              narrow window has dropped, and the three repository icons the bar
//              gives up below 481px, which are looked for in the More menu that
//              the stylesheet says repeats them, read with that menu open
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
    // One window of a search, in the shape the backend publishes. The answer is
    // deliberately not complete: a settled scan hides the layer's own paging
    // button, and that button is part of what this probe lays out. The fragments
    // are computed from the query rather than written down, because the row is
    // drawn by slicing the string at those units — an off-by-one here would draw
    // a row that no real answer could produce, and the layer would be measured
    // with furniture instead of content. The fixture's own strings are ASCII, so
    // byte and UTF-16 offsets coincide and both are given honestly.
    search_repository: (A) => {
      const needle = String((A && A.query) || "");
      const low = needle.toLowerCase();
      const frag = (text) => {
        const at = text.toLowerCase().indexOf(low);
        if (at < 0) return null;
        return [{ byteStart: at, byteEnd: at + needle.length, unitStart: at, unitEnd: at + needle.length }];
      };
      const commits = COMMITS.map((one) => {
        const subject = frag(one.subject);
        const body = frag(one.message);
        const hits = [];
        if (subject) hits.push({ field: "subject", tier: "subsequence", fragments: subject });
        if (body) hits.push({ field: "body", tier: "subsequence", fragments: body });
        return {
          oid: one.oid,
          message: one.message,
          subjectEndBytes: one.subject.length + 1,
          subjectEndUnits: one.subject.length + 1,
          authorName: one.authorName,
          commitDate: one.commitDate,
          offset: 0,
          hits,
        };
      });
      const refs = [];
      for (const branch of REFS.branches) {
        const fragments = frag(branch.name);
        if (fragments) {
          refs.push({ kind: "branch", name: branch.name, commitOid: branch.oid, head: branch.current, reachedFromHead: true, tier: "subsequence", fragments });
        }
      }
      for (const tag of REFS.tags) {
        const fragments = frag(tag.name);
        if (fragments) {
          refs.push({ kind: "tag", name: tag.name, commitOid: tag.target, head: false, reachedFromHead: true, tier: "subsequence", fragments });
        }
      }
      return {
        context: A.context,
        value: {
          queryId: A.queryId,
          head: window.__SNAPSHOT__.branch.oid,
          refsGeneration: window.__SNAPSHOT__.refsGeneration,
          window: {
            cursor: A.cursor,
            scanned: COMMITS.length,
            complete: false,
            stoppedBy: null,
            nextCursor: COMMITS.length,
            hitsTruncated: false,
            commits,
            refs,
          },
        },
      };
    },
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
    if (button) {
      const menu = button.closest(".repository-menu");
      if (menu?.hidden) document.querySelector(".appbar-repo").click();
      button.click();
    }
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
  // Typing into the field is the only way the result layer opens: the view asks
  // on its own clock, so this writes the text and fires the same input event a
  // keyboard would, and the caller sleeps past the debounce before measuring.
  window.__SEARCH__ = (text) => {
    const field = document.querySelector(".search-field");
    if (!field) return false;
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
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
                      "--gutter", "--detail-cap", "--list-cap", "--search-cap"]) {
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
  // Two layers float over the page: the branch picker borrows a page-sized
  // overlay, and the search field draws its results into a smaller one. Both are
  // opaque, so what sits under one is not painted and cannot be mislaid: it is
  // left out rather than reported as a hundred overlaps. A layer that is only
  // partly transparent is read *through*, so the claim is about its paint, not
  // about its z-index — and a partial layer hides only what it actually covers.
  const stage = document.querySelector(".stage");
  const isOpaque = (node) => {
    const background = getComputedStyle(node).backgroundColor;
    return background !== "" && background !== "transparent" && background.indexOf("rgba(") !== 0;
  };
  const floaters = Array.from(document.querySelectorAll(".overlay:not([hidden]), .search-results:not([hidden])"))
    .filter(isOpaque)
    .map((node) => ({
      node: node,
      box: node.getBoundingClientRect(),
      kind: node.classList.contains("search-results") ? "search" : "picker",
    }));
  // Which layer hides a node, kept rather than a bare yes/no: "the panel is
  // unreadable under it" is a different claim about the picker and about the
  // search layer, and the count that says which one did it is cheap here.
  const coveredBy = (node) => {
    for (const one of floaters) {
      if (one.node.contains(node)) continue;
      if (!stage || !stage.contains(node)) continue;
      const box = node.getBoundingClientRect();
      if (box.right > one.box.left && box.left < one.box.right
        && box.bottom > one.box.top && box.top < one.box.bottom) return one.kind;
    }
    return null;
  };
  // The picker's own layer, reported separately because its promise is about the
  // whole stage: it is only a fix for a cramped panel if it really hides it.
  const layer = document.querySelector(".overlay:not([hidden])");
  const layerBox = layer ? layer.getBoundingClientRect() : null;
  const layerPaint = layer ? getComputedStyle(layer) : null;
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
      // Which layer hides it, or null: a truthy string is what drawn filters
      // on, and the name says which of the two layers the claim is about.
      hidden: coveredBy(node),
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
    // How many lines the bar is drawn in. The bar gives way downwards on purpose
    // once the controls with hard floors on it need more width than the window
    // has, so a height alone cannot say whether those lines got dense: two
    // full-height lines and two compacted ones measure the same number. A line is
    // counted by vertical band — items share one when their boxes overlap
    // vertically — which is what the row drew, not a length this check brought
    // along and hopes to find.
    appbarLines: (() => {
      const bar = document.querySelector(".appbar");
      if (!bar) return null;
      const boxes = Array.from(bar.children)
        .map((node) => node.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0)
        .sort((a, b) => a.top - b.top);
      let lines = 0;
      let bandBottom = -Infinity;
      for (const box of boxes) {
        if (box.top >= bandBottom) { lines += 1; bandBottom = box.bottom; }
        else if (box.bottom > bandBottom) { bandBottom = box.bottom; }
      }
      return lines > 0 ? lines : null;
    })(),
    // The gap between those lines, in the same layout pixels as the height: it is
    // room the row spends between lines, not room one line takes, so a per-line
    // length that left it in would blame the token for the gap.
    appbarGapPx: (() => {
      const bar = document.querySelector(".appbar");
      if (!bar) return null;
      const gap = parseFloat(getComputedStyle(bar).rowGap);
      return Number.isFinite(gap) ? gap : 0;
    })(),
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
      search: probe(".main-panel > .search-view"),
      changes: probe(".main-panel > .changes-view"),
      history: probe(".main-panel > .history-view"),
      fileList: probe(".main-panel > .changes-view .file-list"),
      historyList: probe(".main-panel > .history-view .history-list"),
      splitter: probe(".main-splitter"),
    },
    // The result layer, and what its cap actually did to the window it holds.
    // A row the cap cuts off is a row the scroller will bring back, so the count
    // that matters is the one drawn against the *painted* rect: the layer is
    // only keeping its promise if some rows are cut and none are lost.
    search: (() => {
      // The top bar refactor moved the search field into the main toolbar, so the
      // search view is a child of .main-toolbar rather than of .main-panel;
      // the results layer still hangs off the field itself.
      const results = document.querySelector(".main-toolbar .search-view .search-results");
      if (!results) return null;
      const rows = Array.from(results.querySelectorAll(".search-row"));
      const drawn = rows.filter((row) => {
        const box = painted(row);
        return box.w > 0 && box.h > 0;
      });
      const changes = document.querySelector(".main-panel > .changes-view");
      const history = document.querySelector(".main-panel > .history-view");
      const box = results.getBoundingClientRect();
      const hit = (node) => {
        if (!node) return false;
        const other = node.getBoundingClientRect();
        return box.right > other.left && box.left < other.right
          && box.bottom > other.top && box.top < other.bottom;
      };
      return {
        open: results.hidden !== true,
        box: bounds(results),
        // The cap as the renderer resolved it, not as the token was written: an
        // unregistered custom property reads back its own vh token here, while
        // the element's used max-height is the pixels the layout spent.
        maxHeightPx: px(getComputedStyle(results).maxHeight),
        rows: rows.length,
        drawnRows: drawn.length,
        cutRows: rows.length - drawn.length,
        scrolls: results.scrollHeight > results.clientHeight + 1,
        // How much of the panel this one layer is the reason is not painted —
        // counted from the nodes this measurement already decided about, so the
        // number belongs to the layer that hides them and not to whichever
        // floater happened to be on the page as well.
        hides: textNodes.filter((one) => one.hidden === "search").length,
        // The bar it hangs off is the reason the layer starts where it does: a
        // layer drawn over its own bar would be a layer pushing the page down.
        overBar: (() => {
          const bar = document.querySelector(".main-toolbar .search-view .search-bar");
          if (!bar) return null;
          return box.top < bar.getBoundingClientRect().bottom - 1;
        })(),
        overChanges: hit(changes),
        overHistory: hit(history),
        insideViewport: box.left >= -1 && box.right <= window.innerWidth + 1
          && box.top >= -1 && box.bottom <= window.innerHeight + 1,
      };
    })(),
    // How many bands the graph's own head row drew, counted the way the app bar's
    // lines are: by vertical overlap, which is what the row laid out rather than
    // a width this check brought along and hopes to find. This is the row whose
    // flex-wrap was decided when it carried one more control than it does now.
    historyHead: (() => {
      const head = document.querySelector(".history-list-head");
      if (!head) return null;
      const boxes = Array.from(head.children)
        .map((node) => node.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0)
        .sort((a, b) => a.top - b.top);
      let lines = 0;
      let bandBottom = -Infinity;
      let right = 0;
      for (const box of boxes) {
        right = Math.max(right, box.right);
        if (box.top >= bandBottom) { lines += 1; bandBottom = box.bottom; }
        else if (box.bottom > bandBottom) { bandBottom = box.bottom; }
      }
      return { lines: boxes.length === 0 ? null : lines, right: boxes.length === 0 ? null : right };
    })(),
    overlay: (() => {
      if (!layer) return { open: false };
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
  Main: ["Main", "Settings", "Open repository", "Refresh status", "Repository menu",
         "Switch branch", "Changed files", "Commit message", "Commit history"],
  // The layer is a third thing on the page, and it is the only screen with
  // these controls.
  Picker: ["Filter branches and tags", "New branch name", "Branches and tags"],
  // The field, the list it opened and the one action the layer offers below the
  // rows. The search reads no file and writes nothing, so this is the whole set
  // of controls the layer adds to the page.
  Search: ["Main", "Settings", "Search commits, branches and tags", "Search results",
           "Search further back", "Changed files", "Commit history"],
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
    { key: "Picker", enter: 'window.__TAB__("Main"); window.__BAR__("Branches and tags")' },
    { key: "Search", enter: 'window.__TAB__("Main"); window.__SEARCH__("commit")' },
    { key: "Settings", enter: 'window.__TAB__("Settings")' },
    { key: "Welcome", enter: 'window.__TAB__("Main"); window.__BAR__("Close session")' },
  ];

  // The three repository icons are the ones the bar hands over at the declared
  // minimum, by the words the More menu repeats them with. The stylesheet says
  // they go somewhere that already holds them; that is only a fix if the copies
  // are really there, so a name missing from the bar is looked for in the menu
  // before it is called unreachable.
  const HANDED_OVER = ["Open repository", "Refresh status", "Close session"];
  let mainGeo = null;

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

    // Read the handoff once per size, with the menu opened and closed again by
    // its own controls: at the widths where nothing is handed over this stays an
    // empty list, so no screen can borrow a pass from a menu it never opened.
    const carried = await evaluate(`(() => {
      const button = document.querySelector('.appbar [aria-label="Repository menu"]');
      if (!button) return [];
      button.click();
      const names = Array.from(document.querySelectorAll(".repository-menu .menu-item"))
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => (node.textContent || "").trim());
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return names;
    })()`);
    {
      check(`[${size.label}] the repository menu contains open, refresh and close`,
            HANDED_OVER.every((name) => carried.includes(name) || carried.includes(name + "…")),
            carried.join(", "));
    }

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
      if (screen.key === "Main") mainGeo = report;
      if (screen.key === "Search") {
        const s = report.search;
        check(`${where}: the field's answer is a layer on the page`,
              s !== null && s.open === true && s.rows > 0,
              s === null ? "no layer in the built bundle"
                : `${s.rows} rows, ${s.drawnRows} painted, box ${Math.round(s.box.w)}x${Math.round(s.box.h)}`);
        // The claim the whole design rests on: a floating answer costs the panel
        // nothing below it. Measured against this same size's own reading with
        // the layer closed, to the pixel the renderer laid out.
        const same = mainGeo !== null && s !== null
          && Math.abs(mainGeo.regions.changes.y - report.regions.changes.y) < 0.001
          && Math.abs(mainGeo.regions.changes.h - report.regions.changes.h) < 0.001
          && Math.abs(mainGeo.regions.history.y - report.regions.history.y) < 0.001
          && Math.abs(mainGeo.regions.history.h - report.regions.history.h) < 0.001;
        check(`${where}: the two areas under it keep the boxes they had closed`,
              same === true,
              mainGeo === null ? "no closed-layer reading at this size"
                : `changes ${report.regions.changes.y.toFixed(3)}+${report.regions.changes.h.toFixed(3)}, `
                  + `history ${report.regions.history.y.toFixed(3)}+${report.regions.history.h.toFixed(3)}`);
        check(`${where}: it covers the page rather than standing beside it`,
              s !== null && s.overChanges === true && s.hides > 0 && s.overBar === false,
              s === null ? "" : `covers the changes area, ${s.hides} of its text nodes not painted, `
                + (s.overHistory ? "and reaches the graph" : "stops above the graph"));
        check(`${where}: the layer keeps its own box inside the window`,
              s !== null && s.insideViewport === true,
              s === null ? "" : `box ${Math.round(s.box.x)},${Math.round(s.box.y)} `
                + `to ${Math.round(s.box.right)},${Math.round(s.box.bottom)} of `
                + `${report.viewport.w}x${report.viewport.h}`);
        // The cap is the promise `--search-cap` makes; what it is worth is how
        // many rows it cut and whether the layer can still bring them back.
        check(`${where}: the cap cuts rows and the scroller still holds them all`,
              s !== null && s.cutRows > 0 && s.drawnRows > 0 && s.scrolls === true,
              s === null ? "" : `${s.drawnRows} of ${s.rows} rows painted, ${s.cutRows} cut, scrolls=${s.scrolls}`);
        const capPx = s === null ? 0 : s.maxHeightPx;
        const fraction = report.viewport.h > 0 ? capPx / report.viewport.h : 0;
        const capShape = `--search-cap ${Math.round(capPx)}px of ${report.viewport.h}px = ${fraction.toFixed(3)}`;
        // Judged as a fraction of this window's own short axis, never as a pixel
        // count: the layer is capped against the viewport, and the band the
        // stylesheet picks for it moves at 560px and again at 440px.
        if (size.height <= 440) {
          check(`${where}: a very short window caps the layer at the third restatement`,
                Math.abs(fraction - 0.30) < 0.005, `${capShape} (base 40vh, 36vh at 560px, 30vh here)`);
        } else if (size.height <= 560) {
          check(`${where}: a short window caps the layer lower than a roomy one`,
                Math.abs(fraction - 0.36) < 0.005, `${capShape} (base 40vh, 36vh here)`);
        } else {
          check(`${where}: a roomy window caps the layer at its base share`,
                Math.abs(fraction - 0.40) < 0.005, capShape);
        }
      }
      if (screen.key === "Welcome") {
        check(`${where}: the empty state is Main's, not a third page`,
              report.tabs.current[0] === "Main" && report.textCount > 0);
      }

      const actions = await evaluate(NAMES);
      const onScreen = new Set(actions.filter((entry) => !entry.blocked).map((entry) => entry.name));
      const missing = (PAGES[screen.key] || []).filter((name) => !onScreen.has(name));
      // A name the bar gave up is reachable through the copy this size opened,
      // so it is reported as handed over rather than as lost — and only when the
      // menu actually carries those words.
      const handed = missing.filter((name) => HANDED_OVER.includes(name)
        && (carried.includes(name) || carried.includes(name + "…")));
      const unreachable = missing.filter((name) => !handed.includes(name));
      check(`${where}: every action it offers is reachable`, unreachable.length === 0,
            [unreachable.join(", "),
             handed.length > 0 ? "in the repository menu: " + handed.join(", ") : ""]
              .filter(Boolean).join(" | "));
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

    // The graph's own head row: the number that once decided it may break was
    // taken while a control still hung off it that the page no longer has, so it
    // is read again here, against the window it is drawn in rather than against a
    // note. How many bands it needed is printed rather than required — the row is
    // allowed to break where the stylesheet says it may — but no part of it is
    // allowed to sit past the edge, which is the failure the break exists to stop.
    const head = geo.historyHead;
    check(`[${size.label}] the graph's head row keeps every part of it inside the window`,
          head !== null && head.right !== null && head.right <= geo.viewport.w + 1,
          head && head.right !== null
            ? `widest part ends at ${Math.round(head.right)} of ${geo.viewport.w}px, `
              + `in ${head.lines} band(s)`
            : "no head row on this screen");

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
      window.__BAR__("Branches and tags");
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
      check(`[${size.label}] both tabs retain their words and accessible names`,
            tabs.labelled.every((t) => t.wordsVisible === true)
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
    // At the widths where the bar hands its icons over, the tree is read with
    // that menu open: an action whose only copy lives in a closed menu is not in
    // the tree a screen reader walks, which is the failure this checks for.
    {
      await evaluate(`document.querySelector('.appbar [aria-label="Repository menu"]').click()`);
      await sleep(250);
    }
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
    {
      await evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
      await sleep(150);
    }
    const axMissing = axNames === null ? [] : PAGES.Main.filter(
      (name) => !axNames.has(name) && !axNames.has(name + "…"));
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
    // Per line, not per bar. The bar is allowed to need a second line when the
    // controls with hard floors on it ask for more width than the window has —
    // that is the answer this layout gives instead of a sideways scroll — and the
    // breakpoint's promise is about what each of those lines costs, so a wrapped
    // bar made of compact lines still keeps it and a wrapped bar made of
    // full-height lines no longer does.
    const rootFont = parseFloat(geo.rootFontSize) || 16;
    const barLines = geo.appbarLines || null;
    const perLineRem = (geo.appbarPx && barLines)
      ? (geo.appbarPx - (geo.appbarGapPx || 0) * (barLines - 1)) / rootFont / barLines : null;
    const barShape = `app bar ${appbarRem === null ? "?" : appbarRem.toFixed(2)}rem in `
      + `${barLines === null ? "?" : barLines} line(s), `
      + `${perLineRem === null ? "?" : perLineRem.toFixed(2)}rem each`;
    if (size.width >= 1100) {
      // One line where there is room for one. Wrapping is the last resort, so a
      // window with slack in it must not be drawn as two rows of chrome: this is
      // the shape the shipped look rests on, read at the widths that are never
      // short of pixels.
      check(`[${size.label}] a wide window draws the app bar as one line`,
            barLines === 1, `${barShape}`);
    }
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

    check("the top bar keeps one or two deliberate rows",
          barLines === 1 || barLines === 2, barShape);
    check("each top bar row remains compact and readable",
          perLineRem !== null && perLineRem >= 1.5 && perLineRem <= 2.8, barShape);

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

    if ([340, 420, 720].includes(size.width)) {
      await evaluate('window.__TAB__("Main")');
      for (const font of [12, 16, 20, 24]) {
        await evaluate(`document.documentElement.style.fontSize = "${font}px"`);
        await sleep(150);
        const header = await evaluate(`(() => {
          const bounds = (node) => {
            const box = node.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
          };
          const nodes = [document.querySelector('.appbar-repo'), ...document.querySelectorAll('.tab-item'), ...document.querySelectorAll('.window-controls button')];
          const boxes = nodes.map(bounds);
          const intersects = (first, second) => first.right > second.left + 1 && second.right > first.left + 1 && first.bottom > second.top + 1 && second.bottom > first.top + 1;
          return {
            boxes,
            inside: boxes.every((box) => box.left >= 0 && box.right <= innerWidth + 1 && box.height >= 24),
            overlap: boxes.some((first, index) => boxes.slice(index + 1).some((second) => intersects(first, second))),
            labels: [...document.querySelectorAll('.tab-label')].every((node) => getComputedStyle(node).display !== 'none' && node.scrollWidth <= node.clientWidth + 1),
            repo: bounds(document.querySelector('.appbar-repo-name')),
            bar: bounds(document.querySelector('.appbar')),
            controls: bounds(document.querySelector('.window-controls')),
          };
        })()`);
        check(`[${size.label}/${font}px] top bar controls fit without overlap`, header.inside && !header.overlap, JSON.stringify(header.boxes));
        check(`[${size.label}/${font}px] tab words and repository identity stay visible`, header.labels && header.repo.width >= font * 2, JSON.stringify(header.repo));
        check(`[${size.label}/${font}px] window controls remain on the first row`, header.controls.top < header.bar.top + font, JSON.stringify(header.controls));
      }
      await evaluate('document.documentElement.style.fontSize = "16px"');
      await sleep(150);
      const beforeCount = await evaluate('document.querySelector(".tabs").getBoundingClientRect().width');
      await evaluate('window.__PENDING__(0)');
      await sleep(150);
      const emptyCount = await evaluate('document.querySelector(".tabs").getBoundingClientRect().width');
      await evaluate('window.__PENDING__(120)');
      await sleep(150);
      const fullCount = await evaluate('document.querySelector(".tabs").getBoundingClientRect().width');
      check(`[${size.label}] zero and 99+ counts reserve the same width`, Math.abs(emptyCount - fullCount) < 0.1 && Math.abs(beforeCount - fullCount) < 0.1, `${beforeCount}/${emptyCount}/${fullCount}`);
      await evaluate('window.__PENDING__(null)');
      await evaluate(`window.__SNAPSHOT__.repo.displayName = "仓库-very-long-repository-name-".repeat(8); window.__BAR__("Refresh status")`);
      await sleep(150);
      const longName = await evaluate(`(() => {
        const name = document.querySelector('.appbar-repo-name');
        const bar = document.querySelector('.appbar');
        return name.textContent.length > 100 && name.scrollWidth > name.clientWidth && bar.scrollWidth <= bar.clientWidth + 1;
      })()`);
      check(`[${size.label}] long repository names truncate within the header`, longName);
      await evaluate('document.querySelector(".appbar-repo").focus()');
      for (const key of ['ArrowDown', 'End', 'Escape']) {
        await session.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
        await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
        const focus = await evaluate(`({ name: document.activeElement.getAttribute('aria-label'), open: !document.querySelector('.repository-menu').hidden })`);
        const expected = key === 'ArrowDown' ? 'Open repository' : key === 'End' ? 'Close session' : 'Repository menu';
        check(`[${size.label}] repository keyboard ${key}`, focus.name === expected && focus.open === (key !== 'Escape'), JSON.stringify(focus));
      }
    }

    if (size.width === 720) {
      await evaluate('document.querySelector(".main-splitter").scrollIntoView({ block: "center" })');
      const drag = await evaluate(`(() => {
        const splitter = document.querySelector('.main-splitter').getBoundingClientRect();
        const changes = document.querySelector('.changes-view').getBoundingClientRect();
        const history = document.querySelector('.history-view').getBoundingClientRect();
        return { x: splitter.left + splitter.width / 2, y: splitter.top + splitter.height / 2, start: splitter.top, top: changes.top, height: changes.height + history.height };
      })()`);
      await session.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x, y: drag.y });
      await session.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: drag.x, y: drag.y });
      await session.call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: drag.x, y: drag.y + 25 });
      await session.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: drag.x, y: drag.y + 25 });
      const moved = await evaluate(`({ value: Number(document.querySelector('.main-splitter').getAttribute('aria-valuenow')), stored: Number(localStorage.getItem('guit.mainSplit')), active: document.querySelector('.main-panel').classList.contains('is-resizing') })`);
      const expectedSplit = Math.max(15, Math.min(85, (drag.start - drag.top + 25) / drag.height * 100));
      check(`[${size.label}] pointer dragging measures only the two regions`, Math.abs(moved.value - expectedSplit) < 0.01, `${moved.value}/${expectedSplit}`);
      check(`[${size.label}] pointer dragging persists and releases capture`, moved.value === moved.stored && !moved.active, JSON.stringify(moved));
      const reset = await evaluate(`(() => { const box = document.querySelector('.main-splitter').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
      await session.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 2, ...reset });
      await session.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 2, ...reset });
      check(`[${size.label}] double-click restores the default split`, await evaluate('Number(localStorage.getItem("guit.mainSplit"))') === 45);
    }
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
