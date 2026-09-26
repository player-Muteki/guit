// Destructive-operation confirmation as a native modal <dialog>.
//
// One dialog serves every ticket kind (discard, clean, branch, tag, stash
// pop/drop, hard reset, worktree/remote removal, remote-branch delete and
// force push). The copy table travels with each request so the wording for
// a given kind always travels with the single-use nonce it belongs to.
// Escape and Cancel both take the cancel path, which consumes nothing on the
// server; focus returns to the element that opened the dialog.

import { currentActivator, el, icon } from "../dom";
import type { PreviewCopy } from "../types";

export type ConfirmRequest = PreviewCopy & {
  kind: string;
  candidates: string[];
  dropped: string[];
  targetOid: string | null;
};

export interface ConfirmDialog {
  readonly element: HTMLDialogElement;
  show(request: ConfirmRequest): void;
  hide(message?: string): void;
  onConfirm(handler: () => void): void;
  /** Receives the reason text, or `"user"` when the user closed it themselves. */
  onCancel(handler: (reason: string | "user") => void): void;
}

export function createConfirmDialog(): ConfirmDialog {
  let opener: HTMLElement | null = null;
  const warning = el("p", { class: "dialog-warning", role: "alert" });
  const list = el("ul", { class: "dialog-list" });
  const dropped = el("p", { class: "dialog-note" });
  const confirmButton = el("button", { class: "btn btn-danger", type: "button" });
  const cancelButton = el("button", { class: "btn", type: "button", text: "Cancel" });
  const element = el("dialog", { class: "dialog dialog-confirm", "aria-label": "Confirm destructive operation" }, [
    el("h2", { class: "dialog-title" }, [icon("warning"), el("span", { text: "Confirm" })]),
    warning,
    list,
    dropped,
    el("div", { class: "dialog-actions" }, [cancelButton, confirmButton]),
  ]);

  let onConfirm: () => void = () => {};
  let onCancel: (reason: string | "user") => void = () => () => {};

  // Every path out of the dialog returns focus to whatever opened it. The
  // browser's own restoration after `close()` is not reliable here: the button
  // that held focus inside the dialog keeps it, which strands keyboard
  // navigation on a node that is no longer on screen.
  const leave = (): void => {
    if (element.open) element.close();
    const target = opener;
    opener = null;
    if (!target) return;
    // WebKit runs its own focus restoration for a closing modal on a later
    // task than the close() call, and it wins over an immediate focus(). One
    // macrotask later the trigger keeps focus instead of the dialog's button,
    // which would otherwise be left focused while off screen.
    setTimeout(() => {
      if (target.isConnected) target.focus();
    }, 0);
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
    opener = currentActivator();
    warning.textContent = request.warning;
    confirmButton.textContent = request.confirm;
    cancelButton.textContent = request.cancel;
    element.setAttribute("aria-label", `${request.confirm}: ${request.kind}`);
    list.replaceChildren(
      ...request.candidates.map((name) =>
        el("li", {
          text: request.targetOid ? `${name} · at ${request.targetOid.slice(0, 10)}` : name,
        }),
      ),
    );
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
