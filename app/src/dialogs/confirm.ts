// Destructive-operation confirmation as a native modal <dialog>.
//
// One dialog serves every ticket kind (discard, clean, branch, tag and a clean
// restore). The copy table travels with each request so the wording for a given
// kind always travels with the single-use nonce it belongs to.
// Escape and Cancel both take the cancel path, which consumes nothing on the
// server; focus returns to the element that opened the dialog.

import { currentActivator, el, icon } from "../dom";
import { shortId, type RestoreSection } from "../restoreModel";
import type { PreviewCopy } from "../types";

// Every kind except a clean restore is asked about one set of paths, so it is
// shown as one list. A restore touches six classes under six different verbs and
// owes each one its own heading — see `restoreModel.ts` for why they cannot be
// flattened into one promise.
export type ConfirmNames =
  | { candidates: string[]; targetOid: string | null }
  | { heading: string; sections: RestoreSection[] };

export type ConfirmRequest = PreviewCopy & {
  kind: string;
  dropped: string[];
  names: ConfirmNames;
};

export interface ConfirmDialog {
  readonly element: HTMLDialogElement;
  show(request: ConfirmRequest): void;
  hide(message?: string): void;
  onConfirm(handler: () => void): void;
  /** Receives the reason text, or `"user"` when the user closed the dialog themselves. */
  onCancel(handler: (reason: string | "user") => void): void;
}

/**
 * @param onFocusFallback where to put focus when the element that opened the
 * dialog no longer exists. A destructive action usually goes through a
 * preview, and the preview returns a fresh snapshot, so by the time the dialog
 * is on screen a virtualised row has been rebuilt and the clicked button is
 * detached. Returning focus to a node that is gone is not an option and
 * leaving it on the dialog's own off-screen button is worse, so the owner
 * names a stable substitute.
 */
export function createConfirmDialog(onFocusFallback?: () => void): ConfirmDialog {
  let opener: HTMLElement | null = null;
  const warning = el("p", { class: "dialog-warning", role: "alert" });
  const names = el("div", { class: "dialog-names" });
  const dropped = el("p", { class: "dialog-note" });
  const confirmButton = el("button", { class: "btn btn-danger", type: "button" });
  const cancelButton = el("button", { class: "btn", type: "button", text: "Cancel" });
  const element = el("dialog", { class: "dialog dialog-confirm", "aria-label": "Confirm destructive operation" }, [
    el("h2", { class: "dialog-title" }, [icon("warning"), el("span", { text: "Confirm" })]),
    warning,
    names,
    dropped,
    el("div", { class: "dialog-actions" }, [cancelButton, confirmButton]),
  ]);

  let onConfirm: () => void = () => {};
  let onCancel: (reason: string | "user") => void = () => () => {};

  // Every path out of the dialog returns focus to whatever opened it. WebKit
  // restores focus for a closing modal on its own schedule and picks the button
  // that had focus *inside* the dialog, so a keyboard user would be left
  // navigating from a node that is no longer on screen. Measured over AT-SPI:
  // after a cancel, the dialog's own button still reported FOCUSED and the
  // trigger did not. Re-asserting against `document.activeElement` until the
  // webview agrees fixes it, and the loop stops the moment it does, so the
  // usual case costs one frame.
  const restoreFocus = (target: HTMLElement): void => {
    let frames = 0;
    const reassert = (): void => {
      if (!target.isConnected) return;
      if (document.activeElement !== target) target.focus();
      if (document.activeElement !== target && ++frames < 30) requestAnimationFrame(reassert);
    };
    reassert();
  };

  const leave = (): void => {
    if (element.open) element.close();
    const target = opener;
    opener = null;
    if (target !== null && target.isConnected) restoreFocus(target);
    else onFocusFallback?.();
  };

  confirmButton.addEventListener("click", () => {
    leave();
    onConfirm();
  });
  cancelButton.addEventListener("click", () => {
    leave();
    onCancel("user");
  });
  // Escape fires `cancel`; a stray close (form method, programmatic) fires
  // `close` without `cancel`. Both resolve to the same safe outcome.
  element.addEventListener("cancel", (event) => {
    event.preventDefault();
    leave();
    onCancel("user");
  });

  const show = (request: ConfirmRequest): void => {
    // The opener belongs to the dialog session, not to each refresh: a ticket
    // is re-shown whenever the preview is recomputed, and by then the control
    // that opened it is usually gone and the dialog's own confirm button holds
    // focus. Capturing again would hand focus back to a node inside the dialog.
    if (!element.open) opener = currentActivator();
    warning.textContent = request.warning;
    confirmButton.textContent = request.confirm;
    cancelButton.textContent = request.cancel;
    element.setAttribute("aria-label", `${request.confirm}: ${request.kind}`);
    names.replaceChildren(...nameNodes(request.names));
    dropped.hidden = request.dropped.length === 0;
    dropped.textContent = `${request.droppedLabel ?? "Skipped (no work-tree changes)"}: ${request.dropped.join(", ")}`;
    if (!element.open) element.showModal();
    confirmButton.focus();
  };

  const hide = (message?: string): void => {
    leave();
    onCancel(message ?? "");
  };

  return {
    element,
    show,
    hide,
    onConfirm(handler) { onConfirm = handler; },
    onCancel(handler) { onCancel = handler; },
  };
}

function nameList(items: string[], annotate: (name: string) => string): HTMLElement {
  return el("ul", { class: "dialog-list" }, items.map((item) => el("li", { text: annotate(item) })));
}

// One flat list, or one heading and a section per class of path. The dialog draws
// whichever the ticket carries and never decides for itself which is the case.
function nameNodes(names: ConfirmNames): Node[] {
  if ("candidates" in names) {
    const oid = names.targetOid;
    return [nameList(names.candidates, (name) => (oid === null ? name : `${name} · at ${shortId(oid)}`))];
  }
  const nodes: Node[] = [el("p", { class: "dialog-target", text: names.heading })];
  for (const section of names.sections) {
    nodes.push(
      el("section", { class: "dialog-section" }, [
        el("h3", { class: "dialog-section-label", text: section.label }),
        nameList(section.items, (name) => name),
      ]),
    );
  }
  return nodes;
}
