// A credential prompt arrives as an `askpass-request` event: categorised
// material only, already proven safe to display by the Rust side (the wording
// itself is decided in `askpassPrompt.ts`). The answer goes straight into
// `submit_askpass` and lives nowhere else. Cancel just closes the dialog — the
// blocked prompt then expires on the Rust side and Git fails on its own. The
// submit button is deliberately NOT named "Cancel": an accessibility run showed
// three same-named Cancel buttons colliding, so a driver click could cancel the
// wrong lane.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { currentActivator, el, icon } from "../dom";
import { promptText, replacesPrompt } from "./askpassPrompt";
import type { AskPassRequest } from "../types";

export interface AskpassDialog {
  readonly element: HTMLDialogElement;
}

export function createAskpassDialog(onError: (error: unknown) => void): AskpassDialog {
  const prompt = el("p", { class: "dialog-warning" });
  const secret = el("input", {
    class: "input",
    type: "password",
    autocomplete: "off",
    spellcheck: false,
    "aria-label": "Credential",
  });
  const submit = el("button", { class: "btn btn-primary", type: "button", text: "Submit" });
  const cancel = el("button", { class: "btn", type: "button", text: "Cancel" });
  const element = el("dialog", { class: "dialog dialog-askpass", role: "group", "aria-labelledby": "askpass-prompt" }, [
    el("h2", { class: "dialog-title" }, [icon("pin"), el("span", { id: "askpass-prompt", text: "Credential required" })]),
    prompt,
    secret,
    el("div", { class: "dialog-actions" }, [cancel, submit]),
  ]);

  let pending: AskPassRequest | null = null;
  let opener: HTMLElement | null = null;

  const close = (): void => {
    if (element.open) element.close();
    secret.value = "";
    pending = null;
    opener?.focus();
    opener = null;
  };

  submit.addEventListener("click", () => {
    const request = pending;
    const value = secret.value;
    // `close()` clears the pending request, so a second click on the same
    // dialog has nothing left to answer.
    close();
    if (!request || value === "") return;
    void invoke("submit_askpass", { operationId: request.operationId, secret: value }).catch(onError);
  });
  cancel.addEventListener("click", close);
  element.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  secret.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit.click();
    }
  });

  void listen<AskPassRequest>("askpass-request", ({ payload }) => {
    const replaced = replacesPrompt(pending, payload);
    pending = payload;
    secret.type = payload.kind === "password" ? "password" : "text";
    // Never carry an answer across questions: the text belongs to the target
    // it was typed for.
    secret.value = "";
    prompt.textContent = promptText(payload, replaced);
    if (!element.open) {
      // Only a freshly opened dialog captures where focus came from; an open
      // one keeps its original opener, so closing still returns there.
      opener = currentActivator();
      element.showModal();
    }
    secret.focus();
  });

  return { element };
}
