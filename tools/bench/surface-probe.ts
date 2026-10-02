// Engine probe: what the panel's surfaces actually look like once a renderer has
// drawn them.
//
// The stylesheet is where depth, rhythm and state are *decided*; this file is
// where they are *seen*. Those are different questions, and the two stylesheet
// gates cannot answer the second one. `color-contrast.py` reads token text and
// never asks what a computed `background-color` came out as; `responsive-check.py`
// reads declarations and never asks whether a row moves when the pointer does.
// Both are right about what they check, and both are silent about a surface
// ladder that reads as one flat sheet because nothing casts a shadow.
//
// So this probe boots the shipped sheet and, for the shapes that claim to float
// above the page, reports three things per shape: the background the engine
// resolved it to, the shadow it was given, and the background of the thing it is
// drawn over. A layer that is a flat rectangle on a flat rectangle is not a bug
// anyone can file — it is a number nobody has ever written down.
//
// It also measures the three things that change under the panel's own promise
// rather than under a designer's: whether an interactive element has a transition
// at all, whether a number that changes every few seconds changes width while it
// does, and whether one `ch` means the same thing in the two faces the panel
// draws with.
//
// SCOPE, deliberately. Every check below is either (a) a fact that must already
// hold, asserted, or (b) a number reported with no target attached. Nothing here
// asserts "the layers are deep enough" or "the rows have transitions": those are
// the claims later work makes true, and a gate that failed on them from the start
// would be reporting the plan rather than the panel. Every reporting check is
// prefixed REPORT so a reader can tell a measurement from a gate without reading
// the source, and the numbers are the baseline this file exists to produce.
//
// Usage: /usr/bin/python3 ../tools/bench/webkit-engine-probe.py \
//            surface-probe.ts src/style.css src/style/tokens.css
//        (-v prints the detail of passing checks too, which is the point here)

import { el, openMenu } from "../../app/src/dom";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
  checks.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
}

// --- colour, the way a renderer answers it ---------------------------------
//
// Computed `background-color` is whatever the declaration said, alpha included:
// it is not composited onto the backdrop. A wash measured as its own colour is
// measured as nothing like what a person sees, so every wash here is flattened
// over the surface it is painted on, which is the same flattening
// `color-contrast.py` does on the token text.

type Rgb = [number, number, number];

function parseColor(value: string): { rgb: Rgb; alpha: number } | null {
  const parts = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)$/.exec(value.trim());
  if (parts === null) return null;
  const alpha = parts[4] === undefined ? 1 : parts[4].endsWith("%") ? parseFloat(parts[4]) / 100 : parseFloat(parts[4]);
  return {
    rgb: [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])],
    alpha: Number.isNaN(alpha) ? 1 : alpha,
  };
}

function flatten(top: string, over: Rgb): Rgb | null {
  const parsed = parseColor(top);
  if (parsed === null) return null;
  return parsed.rgb.map((channel, index) => Math.round(parsed.alpha * channel + (1 - parsed.alpha) * over[index])) as Rgb;
}

/** The largest per-channel step between two colours. A palette step has to be
 * visible to be a step, and the channel difference is the number that says by
 * how much; the perceptual one would be nicer and is not what a stylesheet
 * author reasons about. */
function channelStep(first: Rgb, second: Rgb): number {
  return Math.max(...first.map((channel, index) => Math.abs(channel - second[index])));
}

const rgb = (value: Rgb | null): string | null => (value === null ? null : `rgb(${value.join(",")})`);

// --- reading the page ------------------------------------------------------

/** Resolves a token by painting it, not by reading its text: `var()` is only
 * substituted by the cascade, so asking the document is the only way to learn
 * what `--surface-panel` actually came out as. */
function resolved(name: string): Rgb | null {
  const probe = el("span");
  probe.style.position = "absolute";
  probe.style.backgroundColor = `var(${name})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return parseColor(value)?.rgb ?? null;
}

/** The shadow the engine actually resolved, as a count of painted shadows.
 *
 * `boxShadow` is a computed *string*, and `"none"` is a string like any other,
 * so a check written as "is the field non-empty" passes on the one answer that
 * means the sheet declared nothing at all. This is the check's own bug, found by
 * running it: it read green across five layers that cast no shadow whatsoever.
 *
 * So the reading is a count, not a string. `none` counts zero; `rgb(...) a b c`
 * counts one; the two-layer stacks the depth ladder adds count two. A colour
 * with zero alpha is the same absence wearing a value, so a shadow only counts
 * when it carries an alpha above zero. */
function shadowOf(node: HTMLElement): { layers: number; longest: number; cast: string } {
  const value = getComputedStyle(node).boxShadow;
  const layers = value === "none" ? [] : value.split(/,(?![^(]*\))/);
  const painted = layers.filter((one) => {
    const alpha = /rgba?\([^)]*?[,/]\s*([\d.]+)\s*\)/.exec(one);
    return alpha !== null && Number(alpha[1]) > 0;
  });
  const spread = painted.map((one) => {
    // `String.match` with a global flag returns whole matches, groups only in
    // an exec loop — so the obvious one-liner here hands `Number` the strings
    // "8px" and yields NaN, and `Math.max` of a NaN serialises as `null` rather
    // than raising. The reading then reports a length of `null` and looks like
    // a parse miss instead of the two blurs the engine actually resolved.
    const lengths: number[] = [];
    const length = /(-?[\d.]+)px/g;
    for (let hit = length.exec(one); hit !== null; hit = length.exec(one)) lengths.push(Number(hit[1]));
    // A box-shadow length list is offset-x, offset-y, blur, spread: the blur is
    // what gives the layer its reach, so that is the number worth reporting.
    return lengths.length >= 4 ? Math.abs(lengths[2]) : 0;
  });
  return { layers: painted.length, longest: spread.length > 0 ? Math.max(...spread) : 0, cast: value };
}

/** Measures a node's own width rather than the width of whatever flow it landed
 * in. A block-level or grid element inside a plain container reports the
 * container's width, which would read as "this number never changes width" for
 * every one of them — the opposite of what is being measured. An inline-block
 * wrapper shrink-wraps to the content, so the child gets its max-content width
 * whatever its own display is.
 *
 * `host` has to be in the document: a detached node has no layout box at all, and
 * `getBoundingClientRect` answers 0 for every one of them, which would turn this
 * from a measurement into a constant. */
function contentWidth(host: HTMLElement, node: HTMLElement): number {
  const wrapper = el("div");
  wrapper.style.display = "inline-block";
  wrapper.append(node);
  host.append(wrapper);
  const width = wrapper.getBoundingClientRect().width;
  wrapper.remove();
  return width;
}

const SCHEMES = ["light", "dark"] as const;
type Scheme = (typeof SCHEMES)[number];

function inScheme(scheme: Scheme, body: () => void): void {
  const root = document.documentElement;
  const before = root.getAttribute("data-theme");
  root.setAttribute("data-theme", scheme);
  try {
    body();
  } finally {
    if (before === null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", before);
  }
}

// --- the markup under measurement ------------------------------------------
//
// These are the panel's own classes, built with the panel's own `el`, because a
// probe that measures a hand-typed approximation of a component is evidence
// about the approximation. Nothing here is a view: the question is what the
// shipped sheet does with these class names, and a view would only add the
// chance of importing something that needs a host.

function host(className = ""): HTMLElement {
  // Deliberately NOT `.view-body`: that rule is `display: flex`, and a flex item
  // is blockified and stretched to the container's cross size, so an inline-block
  // wrapper inside it would measure the host's width instead of the content's.
  // The panel's own surfaces are wanted where a surface is being compared, which
  // is what `page()` below is for; a shrink-to-fit measurement wants plain flow.
  const node = el("div", { "data-probe-host": "" });
  if (className !== "") node.className = className;
  document.body.appendChild(node);
  return node;
}

/** The page every floating shape is measured over: the panel's own regions, so
 * "what is underneath" has an answer that is a panel surface and not the
 * window's default white. */
function page(): HTMLElement {
  const beneath = host("view-body");
  beneath.append(
    el("div", { class: "main-toolbar" }, [el("div", { class: "search-view" })]),
    el("div", { class: "main-panel" }, [
      el("div", { class: "changes-view" }, [el("div", { class: "file-list" }, [el("div", { class: "file-row" })])]),
      el("div", { class: "history-view" }, [el("div", { class: "history-list" }, [el("div", { class: "commit-row" })])]),
    ]),
  );
  return beneath;
}

interface Floating {
  label: string;
  make: () => HTMLElement;
  /** The surface this shape is drawn over, in the panel's own flow. */
  over: string;
  /** The depth tier the sheet is expected to give this shape, and the smallest
   * blur that tier is allowed to have.
   *
   * The floor is what keeps "it has a box-shadow" from being the whole
   * assertion. A shadow can be declared, counted, and still be too tight to
   * separate anything at 340x400 — `0 1px 1px` is one that reads as a hairline
   * rather than as height. So the check asks for the blur the tier promises,
   * which is the number a reader would look at in review. */
  tier: 1 | 2 | 3;
  blurFloor: number;
}

/** The floor each tier has to clear: enough reach to read as height at the
 * panel's minimum window, and rising with the tier because the tier exists
 * precisely to say how far the layer is from the page. */
const BLUR_FLOOR = [0, 6, 18, 48] as const;

const FLOATING: ReadonlyArray<Floating> = [
  {
    label: "repository menu",
    // The panel's own menu builder, so what gets measured is the element a
    // click produces rather than a class list copied out of the sheet.
    make: () => {
      const anchor = el("button", { class: "appbar-repo", type: "button" }, [el("span", { class: "appbar-repo-name", text: "guit" })]);
      document.body.appendChild(anchor);
      openMenu(anchor, [{ label: "Open repository…", run: () => undefined }]);
      const menu = document.querySelector<HTMLElement>(".menu.float");
      if (menu === null) return el("div", { class: "menu float" });
      anchor.remove();
      return menu;
    },
    over: ".view-body",
    tier: 1,
    blurFloor: BLUR_FLOOR[1],
  },
  {
    label: "search results layer",
    make: () => el("div", { class: "search-results" }, [
      el("div", { class: "search-list" }, [el("button", { class: "search-row", type: "button" })]),
      el("div", { class: "search-footer" }, [el("span", { class: "search-summary" })]),
    ]),
    over: ".main-toolbar",
    tier: 1,
    blurFloor: BLUR_FLOOR[1],
  },
  {
    label: "commit bubble",
    make: () => el("div", { class: "commit-bubble", "data-side": "below" }, [
      el("p", { class: "bubble-message" }),
      el("p", { class: "bubble-line" }),
    ]),
    over: ".history-view",
    tier: 1,
    blurFloor: BLUR_FLOOR[1],
  },
  {
    label: "dialog",
    make: () => el("dialog", { class: "dialog dialog-confirm" }, [
      el("h2", { class: "dialog-title" }, [el("span", { text: "Confirm" })]),
      el("div", { class: "dialog-names" }),
    ]),
    over: ".view-body",
    tier: 3,
    blurFloor: BLUR_FLOOR[3],
  },
  {
    label: "toast",
    make: () => el("div", { class: "toast toast-error", role: "alert" }, [el("span", { class: "toast-message", text: "Something failed." })]),
    over: ".view-body",
    tier: 2,
    blurFloor: BLUR_FLOOR[2],
  },
];

// =============================================================================
function __probe(): string {
  // --- 1. the surface ladder the tokens declare -----------------------------
  //
  // Asserted: both schemes resolve, and the two schemes are not the same sheet.
  // Reported: how far apart each neighbouring pair of grounds actually is. This
  // is the number the elevation ladder is supposed to be made of, and until it
  // is written down "the grounds sit far enough apart" is a claim about intent.
  //
  // The app ground is read once per scheme rather than once per run: a wash is
  // flattened over whatever is behind it, and behind the dark scheme is the dark
  // ground. Reading it once, before `data-theme` is set, flattens every dark
  // wash onto the light one and reports a step of 209 where the real one is 8.

  const LADDER = ["--surface-sunken", "--surface-app", "--surface-panel", "--surface-raised", "--surface-input"];
  const ladder: Record<Scheme, Record<string, Rgb | null>> = { light: {}, dark: {} };
  const grounds: Record<Scheme, Rgb> = { light: [255, 255, 255], dark: [255, 255, 255] };

  for (const scheme of SCHEMES) {
    inScheme(scheme, () => {
      for (const name of LADDER) ladder[scheme][name] = resolved(name);
      grounds[scheme] = resolved("--surface-app") ?? [255, 255, 255];
    });
  }

  for (const scheme of SCHEMES) {
    check(
      `${scheme}: every surface token resolves to a colour`,
      LADDER.every((name) => ladder[scheme][name] !== null),
      ladder[scheme],
    );
  }
  check("the two schemes are two sheets", JSON.stringify(ladder.light) !== JSON.stringify(ladder.dark), {
    lightPanel: rgb(ladder.light["--surface-panel"]),
    darkPanel: rgb(ladder.dark["--surface-panel"]),
  });

  for (const scheme of SCHEMES) {
    const steps = LADDER.map((name, index) => {
      const here = ladder[scheme][name];
      const next = LADDER[index + 1];
      const there = next === undefined ? null : ladder[scheme][next];
      return { from: name, to: next ?? null, step: here !== null && there !== null ? channelStep(here, there) : null };
    });
    // REPORTED, not asserted. The panel/raised step is the one that decides
    // whether a menu reads as above a list; a number is the deliverable here.
    check(`REPORT ${scheme}: the step between neighbouring grounds`, true, steps);
  }

  // --- 2. every shape that claims to float ----------------------------------
  //
  // Asserted: each shape resolved to a real colour and has a real shadow
  // declaration, so the reading is about the panel and not about a parse miss.
  // Reported: how far the layer sits from what is under it, and whether it was
  // given anything to cast. A flat rectangle over a flat rectangle is exactly
  // what a sheet with no shadow ladder produces, and it is invisible in review.

  for (const scheme of SCHEMES) {
    inScheme(scheme, () => {
      const ground = grounds[scheme];
      const beneath = page();
      const readings = FLOATING.map((shape) => {
        const node = shape.make();
        if (node.parentElement === null) beneath.append(node);
        const under = beneath.querySelector<HTMLElement>(shape.over) ?? beneath;
        const below = flatten(getComputedStyle(under).backgroundColor, ground);
        // A wash belongs to the surface under it, so it is flattened over that
        // surface rather than over the app ground it happens to sit inside.
        const own = flatten(getComputedStyle(node).backgroundColor, below ?? ground);
        return {
          layer: shape.label,
          drawnOver: shape.over,
          tier: shape.tier,
          background: rgb(own),
          surfaceUnder: rgb(below),
          stepFromUnder: own !== null && below !== null ? channelStep(own, below) : null,
          shadow: shadowOf(node),
        };
      });

      // Asserted: the layer paints a colour, and it casts at least one shadow
      // that is actually painted. A layer whose only separation from the page
      // is a small luminance step is a flat rectangle drawn on top of another
      // flat rectangle — which is what every layer in this product was until
      // the depth ladder landed, and which review cannot see.
      for (const reading of readings) {
        const shape = FLOATING.find((one) => one.label === reading.layer);
        check(`${scheme}/${reading.layer}: paints a colour and casts a shadow`, reading.background !== null && reading.shadow.layers > 0, reading);
        check(`${scheme}/${reading.layer}: casts as deep as its tier promises`, reading.shadow.longest >= (shape?.blurFloor ?? 0), reading);
      }
      check(`REPORT ${scheme}: what separates each floating layer from the page`, true, readings);

      beneath.remove();
      document.querySelector(".menu.float")?.remove();
    });
  }

  // --- 3. whether an interaction is answered at all --------------------------
  //
  // A row that changes colour with no transition is not "subtle", it is
  // instantaneous, and at 24px interface size on a 340px window the pointer
  // outruns the paint. This reads the declaration the engine resolved rather
  // than assuming one from the sheet: a transition can be written and
  // overridden, and only the computed value says which one won.
  //
  // Asserted: every element resolved a parseable duration, so the reading is a
  // measurement rather than a null. Reported: which of them move at all.

  const INTERACTIVE: ReadonlyArray<{ label: string; tag: "button" | "input"; className: string; within?: string }> = [
    { label: "file row", tag: "button", className: "file-row" },
    // The graph's list row, not the commit box's row of the same name: the sheet
    // styles it as `.history-list .commit-row`, so a bare `.commit-row` measured
    // outside a list matches nothing and reads as a control with no transition —
    // which is exactly what it reported before this wrapper was added. The two
    // rows share a class name because they are both a commit; they are not the
    // same control, and a probe that cannot tell them apart is measuring one of
    // them twice.
    { label: "commit row", tag: "button", className: "commit-row", within: "history-list" },
    { label: "group heading", tag: "button", className: "group-heading" },
    { label: "menu item", tag: "button", className: "menu-item" },
    { label: "search row", tag: "button", className: "search-row" },
    { label: "button", tag: "button", className: "btn" },
    { label: "icon button", tag: "button", className: "icon-btn" },
    { label: "quiet button", tag: "button", className: "btn-quiet" },
    { label: "text input", tag: "input", className: "input" },
  ];

  const interactiveHost = host();
  const motion = INTERACTIVE.map((one) => {
    const node = el(one.tag, { class: one.className, type: one.tag === "button" ? "button" : undefined });
    if (one.within !== undefined) {
      const wrapper = el("div", { class: one.within }, [node]);
      interactiveHost.append(wrapper);
    } else {
      interactiveHost.append(node);
    }
    const style = getComputedStyle(node);
    const duration = style.transitionDuration.split(",")[0].trim();
    const reading = {
      element: one.label,
      className: one.className,
      transitionProperty: style.transitionProperty,
      transitionDuration: style.transitionDuration,
      millis: (() => {
        const hit = /^(\d*\.?\d+)(m?s)$/.exec(duration);
        return hit === null ? null : parseFloat(hit[1]) * (hit[2].endsWith("ms") ? 1 : 1000);
      })(),
      moves: /^(\d*\.?\d+)(m?s)$/.test(duration) ? parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000) > 0 : null,
    };
    node.remove();
    return reading;
  });

  check(
    "every interactive element resolved a transition duration",
    motion.every((one) => one.moves !== null),
    motion.map((one) => `${one.className}=${one.transitionDuration}`),
  );
  // Knife 3. Asserted, not reported: an element that changes on hover and
  // snaps there is a different control from one that eases there, and that
  // difference is exactly what a screenshot cannot show. Nine elements, seven of
  // which snapped, was the reading this gate was written against.
  //
  // The floor is the panel's own token rather than a literal, because
  // `prefers-reduced-motion` zeroes `--transition` for a user who asked for
  // that — and this probe runs with no preference, so it measures the 120ms the
  // token actually resolves to.
  const motionToken = getComputedStyle(document.documentElement).getPropertyValue("--transition").trim();
  const motionFloor = (() => {
    const hit = /(-?\d*\.?\d+)(m?s)/.exec(motionToken);
    return hit === null ? 0 : parseFloat(hit[1]) * (hit[2].endsWith("ms") ? 1 : 1000);
  })();
  check(
    "every interactive element answers a change with the panel's own transition",
    motion.every((one) => one.moves === true && (one.millis ?? 0) >= motionFloor),
    motion.map((one) => `${one.className}=${one.transitionDuration} (token ${motionToken}, floor ${motionFloor}ms)`),
  );
  check("REPORT which elements answer an interaction with a transition", true, motion);
  check("REPORT how many do not", true, `${motion.filter((one) => one.moves === false).length} of ${motion.length} change with no transition`);
  interactiveHost.remove();

  // --- 4. numbers that move while the panel is watched -----------------------
  //
  // The panel's promise is to sit in a corner and be glanceable. A count that
  // changes width every time it crosses a digit boundary moves whatever is
  // beside it, and on a 340px window whatever is beside it is often the only
  // other thing on the line. `tabular-nums` is the fix and it costs nothing;
  // whether these four carry it is a question only a font engine can answer,
  // because `ch` and the advance of a digit are two different measurements.

  const NUMBERED: ReadonlyArray<{ label: string; className: string }> = [
    { label: "tab badge", className: "tab-badge" },
    { label: "history count", className: "history-count" },
    { label: "activity line", className: "activity-line" },
    { label: "detail metadata", className: "detail-meta" },
  ];

  const numberHost = host();
  const numerals = NUMBERED.map((one) => {
    const widths: Record<string, number> = {};
    // Read the variant from a node that is *in the document*. This read was
    // originally off the detached node and answered "" for every element — and
    // "" is indistinguishable from "the sheet declared no font-variant-numeric",
    // so the reading could never have told a missing declaration from a missing
    // node. The same detached read is why the three `ch`-aware numbers never
    // moved: a node with no box measures whatever it measures, which is nothing.
    // `contentWidth` appends before it measures, so the widths were honest; only
    // this line was not, and it was the line the check reads.
    let variant: string | null = null;
    for (const text of ["9", "10", "100"]) {
      const node = el("span", { class: one.className, text });
      numberHost.append(node);
      if (variant === null) variant = getComputedStyle(node).fontVariantNumeric;
      widths[text] = Number(contentWidth(numberHost, node).toFixed(2));
      node.remove();
    }
    const values = Object.values(widths);
    return {
      element: one.label,
      className: one.className,
      fontVariantNumeric: variant,
      widths,
      spread: Number((Math.max(...values) - Math.min(...values)).toFixed(2)),
    };
  });
  check("every numbered element measured three widths", numerals.every((one) => Object.keys(one.widths).length === 3), numerals);
  // Knife 3. Asserted: a number whose box changes width moves whatever is
  // beside it, and on the smallest window whatever is beside it is often the
  // only other thing on the line. Two things prevent that — fixed digits
  // (`tabular-nums`) or a reserved box — and either is a correct answer, so
  // the check asks that a moving number have one of them rather than asking for
  // a particular mechanism.
  //
  // `.tab-badge` and `.detail-meta` pass the second way today: the badge
  // reserves `3ch`, and the detail row is a block whose width never depended on
  // its content. Both are correct, and neither needs `tabular-nums`.
  check(
    "a number that changes width is held to a fixed width or tabular figures",
    numerals.every((one) => one.spread === 0 || (one.fontVariantNumeric ?? "").includes("tabular-nums")),
    numerals.map((one) => `${one.className}: spread ${one.spread}, font-variant-numeric "${one.fontVariantNumeric}"`),
  );
  check("REPORT whether a number that changes also changes width", true, numerals);
  numberHost.remove();

  // --- 5. one `ch`, two faces ------------------------------------------------
  //
  // A `ch` is the advance of "0" in whatever font the element resolved to, so the
  // same declaration buys different widths in the UI stack and the mono stack.
  // Two columns measured against the same-looking `ch` therefore line up with
  // each other and with nothing else. Reported, because whether it bites
  // depends on which elements share a `ch`, and that is a decision about the
  // design rather than about the sheet.
  //
  // The stacks are handed to the element as the token's own text rather than as
  // `var(--font-mono)`. Written that way and assigned through CSSOM, the
  // substitution does not happen on this engine and both probes inherit the body
  // face — which reports a ratio of exactly 1 and a clean pass on a measurement
  // that never ran. A third family nothing inherits is measured alongside, so a
  // future run cannot mistake "both faces measure the same" for "this engine
  // cannot tell faces apart".

  const chHost = host();
  const chOf = (fontFamily: string): number => {
    const node = el("span", { text: "0" });
    node.style.position = "absolute";
    node.style.fontFamily = fontFamily;
    chHost.append(node);
    const width = node.getBoundingClientRect().width;
    node.remove();
    return width;
  };
  const stackOf = (token: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(token).trim() ||
    getComputedStyle(document.body).fontFamily;
  const uiStack = stackOf("--font-ui");
  const monoStack = stackOf("--font-mono");
  const uiCh = chOf(uiStack);
  const monoCh = chOf(monoStack);
  const controlCh = chOf("serif");
  check(
    // 0.5px, not "any difference at all". A font engine that has really loaded
    // two faces differs by a whole fraction of an em on the digit "0" — several
    // tenths of a pixel at the body size — so anything under half a pixel means
    // it served one face for all three and this measurement did not happen. The
    // first version of this check used 0.01px and passed at 0.03, reporting
    // "the two faces measure the same" as though it were a fact about the panel
    // when it was a fact about the host.
    "the measurement can tell two faces apart at all",
    controlCh > 0 && (Math.abs(controlCh - uiCh) >= 0.5 || Math.abs(controlCh - monoCh) >= 0.5),
    {
      uiCh,
      monoCh,
      controlCh,
      verdict: Math.abs(controlCh - uiCh) < 0.5 && Math.abs(controlCh - monoCh) < 0.5
        ? "this host served one face for all three; the ch numbers below are not a measurement of the panel"
        : "faces differ as expected",
    },
  );
  check("both stacks measured a ch", uiCh > 0 && monoCh > 0, { uiCh, monoCh });
  // The stacks themselves are in the report because "the two faces measure the
  // same" has two very different explanations — the panel naming one family, or
  // this host resolving both names to the same one — and only the text tells
  // them apart.
  check("REPORT how far one ch drifts between the two faces the panel draws with", true, {
    uiStack,
    monoStack,
    uiCh: Number(uiCh.toFixed(3)),
    monoCh: Number(monoCh.toFixed(3)),
    controlCh: Number(controlCh.toFixed(3)),
    ratio: Number((uiCh / monoCh).toFixed(3)),
  });
  chHost.remove();

  document.querySelectorAll("[data-probe-host]").forEach((node) => node.remove());

  return JSON.stringify({ engine: navigator.userAgent, checks });
}

(window as unknown as { __probe: () => string }).__probe = __probe;