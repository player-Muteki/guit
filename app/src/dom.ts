// Minimal DOM construction helpers. No framework: every view builds its own
// subtree through `el`, and icons come from the hand-drawn 16px stroke set in
// `ICONS` (codicon-flavoured, no icon dependency).

const SVG_NS = "http://www.w3.org/2000/svg";

const ACTIVATORS = "button, [role='menuitem'], input, select, textarea, a[href]";

let lastActivator: HTMLElement | null = null;

// `document.activeElement` is not enough to find what a dialog should return
// focus to: an action reached through a floating menu runs after the menu item
// has been removed from the tree, so focus has already fallen back to the body.
// One capture-phase listener records the nearest activatable ancestor of every
// click, and `currentActivator` prefers the live focus when there is one.
document.addEventListener(
  "click",
  (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(ACTIVATORS) : null;
    if (target) lastActivator = target;
  },
  true,
);

export function noteActivator(element: HTMLElement): void {
  lastActivator = element;
}

export function currentActivator(): HTMLElement | null {
  // "What did the user last activate" is the question a dialog needs answered,
  // and that is the click record — not the focus. `showModal()` takes focus
  // for itself and the close hands it back on WebKit's schedule, so reading
  // `activeElement` at the moment a dialog opens describes the dialog, not the
  // caller. The focus is only consulted when no click has been recorded.
  if (lastActivator?.isConnected) return lastActivator;
  const active = document.activeElement;
  return active instanceof HTMLElement && active.matches(ACTIVATORS) ? active : null;
}

export type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  hidden?: boolean;
  id?: string;
  role?: string;
  tabIndex?: number;
  rows?: number;
  autocomplete?: string;
  spellcheck?: boolean;
  for?: string;
  [key: `data-${string}`]: string | undefined;
  [key: `aria-${string}`]: string | number | boolean | undefined;
}

function appendChild(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in node) {
      // Property assignment keeps `value`, `checked`, `disabled` and friends
      // in sync; everything else (role, aria-*, data-*) falls back to
      // attributes below.
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) appendChild(node, child);
  return node;
}

export function button(
  label: string,
  onClick: () => void,
  options: { class?: string; title?: string; ariaLabel?: string; disabled?: boolean } = {},
): HTMLButtonElement {
  const node = el("button", {
    class: options.class ?? "btn",
    type: "button",
    text: label,
    title: options.title,
    "aria-label": options.ariaLabel,
  });
  node.disabled = options.disabled ?? false;
  node.addEventListener("click", onClick);
  return node;
}

export function icon(name: keyof typeof ICONS, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("icon");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

// 16x16 stroke paths on a 24-unit grid feel cramped; these are drawn on a
// 16-unit grid with 1.25px strokes, matching the codicon weight.
//
// Only the glyphs the views actually draw. An icon nothing calls is a
// drawing that has to be kept correct and re-checked against the stylesheet
// for nothing, so an action that reads better as a word -- Open, Discard,
// Diff -- carries the word.
const ICONS = {
  changes: ["M2 4h5v5H2z", "M9 4h5v5H9z", "M2 11h5v3H2z", "M9 11h5v3H9z"],
  main: ["M2 3h12v4.5H2z", "M2 9.5h12v4H2z"],
  history: ["M8 3a5 5 0 1 1-4.6 3", "M3 3v3h3", "M8 5.5V8l2 1.5"],
  branches: ["M4 3v10", "M4 6h4a2 2 0 0 1 2 2v0", "M12 3v3a2 2 0 0 1-2 2H4", "M4 13a1.5 1.5 0 1 0 0 .01"],
  stash: ["M2 4h12v3H2z", "M3 7v6h10V7", "M6 9.5h4"],
  worktrees: ["M2 3h5v10H2z", "M9 3h5v4H9z", "M9 9h5v4H9z"],
  settings: ["M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5z", "M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"],
  branch: ["M4 3.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z", "M4 9.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z", "M12 3.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z", "M4 6v6", "M5.5 5h5a1 1 0 0 1 1 1v0"],
  folder: ["M2 4h4l1.5 2H14v7H2z"],
  refresh: ["M13 8a5 5 0 1 1-1.6-3.7", "M13 2v3h-3"],
  pin: ["M8 1.5 9.5 6 14 7.5 9.5 9 8 13.5 6.5 9 2 7.5 6.5 6z"],
  more: ["M3.5 8h.01", "M8 8h.01", "M12.5 8h.01"],
  close: ["M3.5 3.5l9 9", "M12.5 3.5l-9 9"],
  warning: ["M8 1.5 15 14H1z", "M8 6v4", "M8 11.5v.01"],
  check: ["M2.5 8.5 6.5 12.5 13.5 3.5"],
  // A drop of ink: the panel's own word for a colour choice is a colour, and the theme
  // section needs a mark that is not the gear already heading the page above it.
  droplet: ["M8 2.5 12.1 8.5a4.6 4.6 0 1 1-8.2 0z"],
} as const;

export type IconName = keyof typeof ICONS;

export type MenuItem = { label: string; run: () => void; danger?: boolean };

// Floating row/menu popup: anchored under `anchor`, dismissed by Escape, the
// next outside click, or picking an item. One instance at a time — opening a
// second replaces the first. Every exit path runs through `close`, so the
// document listener and the key handler are always removed and focus always
// goes back to the anchor.
export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  document.querySelector(".menu.float")?.remove();
  const menu = el("div", { class: "menu float", role: "menu" });
  const close = (restoreFocus = true): void => {
    menu.remove();
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    if (restoreFocus) anchor.focus();
  };  const onOutside = (event: MouseEvent): void => {
    if (!menu.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  for (const item of items) {
    const entry = el("button", {
      class: `menu-item${item.danger ? " danger" : ""}`,
      type: "button",
      role: "menuitem",
      text: item.label,
    });
    entry.addEventListener("click", () => {
      // The item is about to leave the tree, so the anchor is what a dialog
      // opened from this menu must give focus back to.
      noteActivator(anchor);
      close(false);
      item.run();
    });
    menu.append(entry);
  }
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(4, rect.right - 170)}px`;
  menu.style.top = `${rect.bottom + 2}px`;
  document.body.append(menu);
  // Deferred by a tick so the click that opened the menu does not immediately
  // close it again.
  setTimeout(() => {
    document.addEventListener("click", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  (menu.firstElementChild as HTMLElement | null)?.focus();
}

/**
 * "1 branch" / "3 branches". The narrow layout gives a status line one or two
 * rows, and `4 commit(s) — all loaded.` spent a whole line on a bracket that
 * only exists because nobody wrote the rule down.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
