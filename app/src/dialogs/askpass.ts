// Credential prompt as a native modal <dialog>.
//
// Git's categorised prompt arrives as an `askpass-request` event
// ({operationId, kind, target, user}); the answer goes straight into
// `submit_askpass` and lives nowhere else. Cancel just closes the dialog —
// the blocked prompt then expires on the Rust side and Git fails on its
// own. The submit button is deliberately NOT named "Cancel": M5-07's AT-SPI
// run showed three same-named Cancel buttons colliding, so a driver click
// could cancel the wrong lane.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { currentActivator, el, icon } from "../dom";
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
    pending = payload;
    secret.type = payload.kind === "password" ? "password" : "text";
    secret.value = "";
    prompt.textContent =
      payload.kind === "password" && payload.user !== null
        ? `Password for ${payload.target} as ${payload.user}:`
        : `${payload.kind === "password" ? "Password" : "Username"} for ${payload.target}:`;
    opener = currentActivator();
    if (!element.open) element.showModal();
    secret.focus();
  });

  return { element };
}
