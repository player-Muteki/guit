// The main panel: the search field, the changes area and the commit history of
// the current branch, on one page, visible together.
//
// It composes the regions instead of owning any of their behaviour — each stays
// independently testable, and none of them is a page of its own any more. A page
// for the files and a page for the graph would make the panel two tabs, and the
// panel is one: the point of the layout is that staging a file and reading the
// graph happen in the same glance.
//
// What the panel does own is the split between the two lists: a user on a short
// window decides which of the two regions gets the room, and both keep a
// floor the drag cannot go below. The ratio lives in `--main-split`, so the
// stylesheet owns the geometry and this file only answers "how much". The search
// field is not part of that bargain — it is chrome, and it keeps its own height
// whatever the split says.

import { el } from "../dom";
import { onDispose } from "../lifecycle";
import {
  readStoredSplit,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_PAGE,
  SPLIT_STEP,
  splitFromPointer,
  stepSplit,
} from "../splitModel";
import type { ViewDescriptor } from "../shell";

const SPLIT_KEY = "guit.mainSplit";

// The list inside a region is the part that gives room up; everything else the
// region holds is what it must keep showing.
const LIST_SELECTOR = ".file-list, .history-list";

export function createMainPanel(
  search: HTMLElement,
  changes: HTMLElement,
  history: HTMLElement,
): ViewDescriptor {
  const splitter = el("div", {
    class: "splitter main-splitter",
    role: "separator",
    "aria-orientation": "horizontal",
    "aria-label": "Resize the split between changes and history",
    tabIndex: 0,
    "aria-valuemin": SPLIT_MIN,
    "aria-valuemax": SPLIT_MAX,
  });
  const element = el("section", { class: "main-panel" }, [search, changes, splitter, history]);

  let stored: string | null;
  try {
    stored = localStorage.getItem(SPLIT_KEY);
  } catch {
    // Storage may be unavailable in private mode; the panel still splits.
    stored = null;
  }
  let split = readStoredSplit(stored);

  const apply = (save: boolean): void => {
    element.style.setProperty("--main-split", String(split));
    splitter.setAttribute("aria-valuenow", String(split));
    splitter.title = `Changes ${split}%, history ${100 - split}%`;
    if (!save) return;
    try {
      localStorage.setItem(SPLIT_KEY, String(split));
    } catch {
      // The next start falls back to the default split.
    }
  };
  apply(false);

  // A region's floor is its list's rows plus the height of everything else that
  // region has to show. That second part is measured from the parts themselves
  // instead of written down, because what the region has to show changes with
  // its state — an operation banner arrives with a merge, the commit box grows
  // when the user drags it, every part grows when the interface zooms — and a
  // floor that is too low by one line is a commit button the user cannot see.
  // The list is excluded on purpose: it is the part that gives room up.
  const regions = [changes, history].map((region) => ({
    region,
    list: region.querySelector<HTMLElement>(LIST_SELECTOR),
  }));
  const written = new Map<HTMLElement, number>();

  const measureChrome = (): void => {
    for (const { region, list } of regions) {
      if (!list) continue;
      const gap = Number.parseFloat(getComputedStyle(region).rowGap) || 0;
      let height = 0;
      let boxes = 0;
      for (const child of Array.from(region.children) as HTMLElement[]) {
        if (child === list) {
          boxes += 1;
        } else if (child.offsetHeight > 0) {
          // A hidden part takes neither room nor a gap beside it.
          height += child.offsetHeight;
          boxes += 1;
        }
      }
      const chrome = height + Math.max(0, boxes - 1) * gap;
      if (written.get(region) === chrome) continue;
      written.set(region, chrome);
      region.style.setProperty("--region-chrome", `${chrome}px`);
    }
  };
  measureChrome();

  // Each part is watched rather than the regions alone: the parts change size
  // while the region's box — decided by the split — stays the same. Writing the
  // floor only when the measurement moved makes this settle in one pass.
  const chromeObserver = new ResizeObserver(measureChrome);
  onDispose(() => chromeObserver.disconnect());
  for (const { region } of regions) {
    chromeObserver.observe(region);
    for (const child of Array.from(region.children)) {
      chromeObserver.observe(child as HTMLElement);
    }
  }

  // The pointer answers "how far down the panel", measured against everything
  // the panel holds: a scrolled panel keeps its content and its share in step,
  // so grabbing the bar twice in a row does not jump.
  const shareAt = (clientY: number): number =>
    splitFromPointer(clientY - element.getBoundingClientRect().top + element.scrollTop, element.scrollHeight);

  let dragging = false;
  splitter.addEventListener("pointerdown", (event) => {
    dragging = true;
    splitter.setPointerCapture(event.pointerId);
    // The bar takes focus on being grabbed, so a drag that ends can be
    // finished with the arrow keys without tabbing back to it.
    splitter.focus();
    event.preventDefault();
  });
  splitter.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    split = shareAt(event.clientY);
    apply(false);
  });
  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    splitter.releasePointerCapture(event.pointerId);
    apply(true);
  };
  splitter.addEventListener("pointerup", endDrag);
  splitter.addEventListener("pointercancel", endDrag);

  splitter.addEventListener("keydown", (event) => {
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = stepSplit(split, SPLIT_STEP); break;
      case "ArrowUp": next = stepSplit(split, -SPLIT_STEP); break;
      case "PageDown": next = stepSplit(split, SPLIT_PAGE); break;
      case "PageUp": next = stepSplit(split, -SPLIT_PAGE); break;
      case "Home": next = SPLIT_MIN; break;
      case "End": next = SPLIT_MAX; break;
      case "Enter":
      case " ": {
        // A bar with a keyboard has to say where it started.
        event.preventDefault();
        split = SPLIT_DEFAULT;
        apply(true);
        return;
      }
      default: return;
    }
    event.preventDefault();
    if (next === split) return;
    split = next;
    apply(true);
  });

  return { id: "main", element };
}
