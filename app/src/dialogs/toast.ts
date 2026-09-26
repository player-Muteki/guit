// Toast stack: failures persist until the user closes or retries them.
//
// M6-05 recorded the single `#error` slot as "last write wins" — a second
// failure silently replaced the first, and a watcher refresh could hide it
// entirely. The stack appends instead; the oldest entry is dropped only
// when a fifth arrives, and every entry carries its own close button and
// optional actions (e.g. "Retry with credentials").

import { el, icon } from "../dom";
import { dismissToast, toastStack } from "../state";
import type { Toast } from "../types";

export interface ToastLayer {
  readonly element: HTMLElement;
  render(): void;
}

export function createToastLayer(): ToastLayer {
  const element = el("div", { class: "toast-layer", "aria-live": "polite" });

  const render = (): void => {
    const entries = toastStack();
    element.replaceChildren(...entries.map((toast) => renderToast(toast)));
  };

  return { element, render };
}

function renderToast(toast: Toast): HTMLElement {
  const close = el("button", {
    class: "toast-close",
    type: "button",
    "aria-label": "Dismiss notification",
  }, [icon("close", 12)]);
  close.addEventListener("click", () => dismissToast(toast.id));
  const actions = (toast.actions ?? []).map((action) => {
    const button = el("button", { class: "toast-action", type: "button", text: action.label });
    button.addEventListener("click", () => {
      dismissToast(toast.id);
      action.run();
    });
    return button;
  });
  return el("div", { class: `toast toast-${toast.level}`, role: "alert" }, [
    el("span", { class: "toast-message", text: toast.message }),
    ...actions,
    close,
  ]);
}
