// Remotes view: the remote list, per-remote actions, and branch
// synchronisation (fetch / pull / push / publish).
//
// The backend reads `git remote` + `get-url` itself and hands over only
// redacted URLs — a URL can embed a credentials token, so the raw form
// never travels to this file. Removal is destructive (it takes the
// remote-tracking refs with it) and runs through the shared one-time
// ticket; adding and re-pointing URLs are ordinary queued writes. Fetch,
// pull, push and publish ride the same streamed lane (3600 s budget,
// redacted `sync-progress` lines) and the mandatory re-read refreshes the
// ↑n ↓m badges everywhere. Push never forces: the one-time force-push
// preview appears only after Git itself refused an update.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { button, el, icon, openMenu } from "../dom";
import {
  applySnapshot,
  consumeCredentialRetry,
  currentSnapshot,
  hasCredentialRetry,
  isForcePushReady,
  isSessionActive,
  isWriteRunning,
  offerCredentialRetry,
  setForcePushReady,
  setStatus,
  setWriteRunning,
  snapshotVersion,
} from "../state";
import type { OperationResult, PullDefault, RemoteView, SyncProgress } from "../types";
import type { PreviewController } from "../dialogs/preview";
import type { SyncAction } from "../shell";

export interface RemotesDeps {
  preview: PreviewController;
  onError(error: unknown): void;
}

export interface RemotesView {
  descriptor: { id: "remotes"; element: HTMLElement };
  sync(): void;
  render(): void;
  run(action: SyncAction): void;
}

export function createRemotesView(deps: RemotesDeps): RemotesView {
  const element = el("section", { class: "view-body remotes-view" });

  const nameInput = el("input", { class: "input", type: "text", placeholder: "Remote name", "aria-label": "New remote name" });
  const urlInput = el("input", { class: "input", type: "text", placeholder: "URL or local path", "aria-label": "New remote URL" });
  const addButton = el("button", { class: "btn btn-primary", type: "button", text: "Add remote" });
  const fetchAllButton = el("button", { class: "btn", type: "button", text: "Fetch all" });
  const addRow = el("div", { class: "view-tools" }, [nameInput, urlInput, addButton, fetchAllButton]);

  const strategySelect = el("select", { class: "input", "aria-label": "Pull strategy", title: "How the fetched upstream is integrated into the current branch" }, [
    el("option", { value: "default", text: "Git default" }),
    el("option", { value: "ffonly", text: "Fast-forward only" }),
    el("option", { value: "merge", text: "Merge" }),
    el("option", { value: "rebase", text: "Rebase" }),
  ]);
  const pullButton = el("button", { class: "btn", type: "button", text: "Pull" });
  const pushButton = el("button", { class: "btn", type: "button", text: "Push" });
  const authRetryButton = el("button", { class: "btn btn-primary", type: "button", text: "Retry with credentials", hidden: true, title: "Retry this operation once, answering Git's credential prompts in this window" });
  const forcePushButton = el("button", { class: "btn btn-danger", type: "button", text: "Preview force push…", hidden: true, title: "Preview what overwriting the upstream under --force-with-lease would erase on the remote" });
  const publishSelect = el("select", { class: "input", "aria-label": "Publish target remote", title: "Remote to create the current branch on" });
  const publishButton = el("button", { class: "btn", type: "button", text: "Publish" });
  const syncRow = el("div", { class: "view-tools sync-row" }, [pullButton, pushButton, strategySelect, publishSelect, publishButton, authRetryButton, forcePushButton]);

  const list = el("div", { class: "ref-list", role: "list", "aria-label": "Remotes" });
  const status = el("span", { class: "view-status", role: "status" });
  element.append(addRow, syncRow, status, list);

  let entries: RemoteView[] = [];
  let requestSeq = 0;
  let syncedVersion = -1;
  let pullDefaultSeq = 0;

  const networkStatusLine = (result: OperationResult): string => {
    const base = result.details ? `${result.message} ${result.details}` : result.message;
    return result.suggestion ? `${base} ${result.suggestion}` : base;
  };

  // Git itself decided the failure is about credentials; that is the only
  // moment the explicit credential path appears, and one click spends it.
  const maybeOfferCredentialRetry = (result: OperationResult, retry: () => void): void => {
    offerCredentialRetry(result.outcome === "failed" && result.category === "auth" ? retry : null);
  };

  const runRemoteWrite = async (
    command: "add_remote" | "set_remote_url",
    args: Record<string, unknown>,
    running: string,
  ): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isWriteRunning()) return;
    offerCredentialRetry(null);
    setWriteRunning(true);
    setStatus(running, "progress");
    try {
      const result = await invoke<OperationResult>(command, { snapshotVersion: snapshot.version, ...args });
      applySnapshot(result.snapshot);
      setStatus(result.details ? `${result.message} ${result.details}` : result.message, "success");
      if (result.outcome === "success" && command === "add_remote") {
        nameInput.value = "";
        urlInput.value = "";
      }
    } catch (error) {
      deps.onError(error);
      setStatus("The remote operation did not run.", "error");
    } finally {
      setWriteRunning(false);
    }
  };

  // The fetch target is the wire-shape the backend enum defines: "all" is
  // the broadcast sweep, { remote } names exactly one entry — even one
  // literally called "all".
  const runFetch = async (target: "all" | { remote: string }, running: string, interactive = false): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isWriteRunning()) return;
    offerCredentialRetry(null);
    setWriteRunning(true);
    setStatus(running, "progress");
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<SyncProgress>("sync-progress", ({ payload }) => setStatus(payload.line, "progress"));
      const result = await invoke<OperationResult>("fetch", { snapshotVersion: snapshot.version, target, interactive });
      applySnapshot(result.snapshot);
      setStatus(networkStatusLine(result), result.outcome === "success" ? "success" : "error");
      maybeOfferCredentialRetry(result, () => void runFetch(target, "Fetching with credentials…", true));
    } catch (error) {
      deps.onError(error);
      setStatus("The fetch did not run.", "error");
    } finally {
      unlisten?.();
      setWriteRunning(false);
    }
  };

  // Pull is one queue unit end to end: the backend fetches the upstream's
  // remote and integrates in the same slot, so the UI never offers a second
  // write while the fetch leg runs. Conflicts arrive as `conflicted` with
  // the banner already showing the sequencer state the snapshot re-read
  // found; the next step belongs to the banner, not to a dialog.
  const runPull = async (strategy: "default" | "ffonly" | "merge" | "rebase", interactive = false): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isWriteRunning()) return;
    offerCredentialRetry(null);
    setWriteRunning(true);
    setStatus(interactive ? "Pulling with credentials…" : "Pulling…", "progress");
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<SyncProgress>("sync-progress", ({ payload }) => setStatus(payload.line, "progress"));
      const result = await invoke<OperationResult>("pull", { snapshotVersion: snapshot.version, strategy, interactive });
      applySnapshot(result.snapshot);
      setStatus(networkStatusLine(result), result.outcome === "success" ? "success" : "error");
      maybeOfferCredentialRetry(result, () => void runPull(strategy, true));
    } catch (error) {
      deps.onError(error);
      setStatus("The pull did not run.", "error");
    } finally {
      unlisten?.();
      setWriteRunning(false);
    }
  };

  // Push names nothing: the backend derives branch, remote and target from
  // a fresh listing, and never forces.
  const runPush = async (interactive = false): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isWriteRunning()) return;
    setForcePushReady(false);
    offerCredentialRetry(null);
    setWriteRunning(true);
    setStatus(interactive ? "Pushing with credentials…" : "Pushing…", "progress");
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<SyncProgress>("sync-progress", ({ payload }) => setStatus(payload.line, "progress"));
      const result = await invoke<OperationResult>("push", { snapshotVersion: snapshot.version, interactive });
      applySnapshot(result.snapshot);
      setStatus(networkStatusLine(result), result.outcome === "success" ? "success" : "error");
      maybeOfferCredentialRetry(result, () => void runPush(true));
      if (
        result.outcome === "failed" &&
        (result.details?.includes("[rejected]") || result.details?.includes("remote rejected"))
      ) {
        setForcePushReady(true);
      }
    } catch (error) {
      deps.onError(error);
      setStatus("The push did not run.", "error");
    } finally {
      unlisten?.();
      setWriteRunning(false);
    }
  };

  // Publish is the first push of a branch: it demands a remote picked from
  // the listing and a branch without an upstream, and the backend refuses
  // both mistakes instead of silently re-pointing a binding.
  const runPublish = async (interactive = false): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isWriteRunning()) return;
    const remote = publishSelect.value;
    if (remote === "") {
      setStatus("Add an addressable remote before publishing.", "error");
      return;
    }
    offerCredentialRetry(null);
    setWriteRunning(true);
    setStatus(interactive ? `Publishing to ${remote} with credentials…` : `Publishing to ${remote}…`, "progress");
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<SyncProgress>("sync-progress", ({ payload }) => setStatus(payload.line, "progress"));
      const result = await invoke<OperationResult>("publish", { snapshotVersion: snapshot.version, remote, interactive });
      applySnapshot(result.snapshot);
      setStatus(networkStatusLine(result), result.outcome === "success" ? "success" : "error");
      maybeOfferCredentialRetry(result, () => void runPublish(true));
    } catch (error) {
      deps.onError(error);
      setStatus("The publish did not run.", "error");
    } finally {
      unlisten?.();
      setWriteRunning(false);
    }
  };

  const run = (action: SyncAction): void => {
    if (typeof action === "object") void runPull(action.strategy);
    else if (action === "fetchAll") void runFetch("all", "Fetching every remote…");
    else if (action === "push") void runPush();
    else if (action === "publish") void runPublish();
  };

  const setUrl = (name: string, push: boolean): void => {
    const url = urlInput.value.trim();
    if (url === "") {
      setStatus("Type the new URL in the URL field first.", "error");
      return;
    }
    void runRemoteWrite("set_remote_url", { name, url, push }, push ? `Re-pointing the push URL of ${name}…` : `Re-pointing the URL of ${name}…`);
  };

  const render = (): void => {
    const locked = !isSessionActive() || isWriteRunning();
    nameInput.disabled = locked;
    urlInput.disabled = locked;
    addButton.disabled = locked;
    fetchAllButton.disabled = locked;
    pullButton.disabled = locked;
    pushButton.disabled = locked;
    publishSelect.disabled = locked;
    publishButton.disabled = locked;
    authRetryButton.disabled = locked;
    authRetryButton.hidden = !hasCredentialRetry();
    forcePushButton.disabled = locked;
    forcePushButton.hidden = !isForcePushReady();
    if (entries.length === 0) {
      list.replaceChildren(el("div", { class: "file-row placeholder", text: "No remotes configured." }));
      return;
    }
    const rows = entries.map((entry) => {
      const urls = [entry.fetchUrl ?? "(no URL)"];
      if (entry.pushUrl) urls.push(`push: ${entry.pushUrl}`);
      const element = el("div", { class: "file-row ref-row", role: "listitem" }, [
        el("span", { class: "file-status", text: "⇅" }),
        el("span", { class: "ref-name", text: entry.name, title: entry.fetchUrl ?? entry.name }),
        el("span", { class: "ref-meta", text: urls.join(" · "), title: urls.join(" · ") }),
      ]);
      if (entry.addressable) {
        element.append(button("Fetch", () => void runFetch({ remote: entry.name }, `Fetching ${entry.name}…`), { class: "row-action" }));
        // The URL input doubles as the new-value field for Set URL; removal
        // needs a losslessly addressable name and goes through the ticket.
        element.append(button("Set URL", () => setUrl(entry.name, false), {
          class: "row-action",
          disabled: isWriteRunning(),
          title: `Type a new URL in the URL field, then click Set URL on ${entry.name}`,
        }));
        const more = el("button", { class: "row-more", type: "button", "aria-label": `More actions for ${entry.name}` }, [icon("more", 14)]);
        more.disabled = isWriteRunning();
        more.addEventListener("click", (event) => {
          event.stopPropagation();
          openMenu(more, [
            ...(entry.pushUrl !== null ? [{ label: "Set push URL…", run: () => setUrl(entry.name, true) }] : []),
            { label: "Remove…", run: () => void deps.preview.request("remoteRemove", { name: entry.name }, null), danger: true },
          ]);
        });
        element.append(more);
      }
      return element;
    });
    list.replaceChildren(...rows);
  };

  const renderPublishTargets = (remotes: RemoteView[]): void => {
    const previous = publishSelect.value;
    publishSelect.replaceChildren(
      ...remotes.filter((entry) => entry.addressable).map((entry) => {
        const option = el("option", { value: entry.name, text: entry.name });
        return option;
      }),
    );
    const names = Array.from(publishSelect.options).map((option) => option.value);
    if (names.includes(previous)) publishSelect.value = previous;
  };

  const placeholder = (message: string): void => {
    entries = [];
    status.textContent = "";
    strategySelect.options[0].textContent = "Git default";
    strategySelect.options[0].title = "";
    renderPublishTargets([]);
    setForcePushReady(false);
    offerCredentialRetry(null);
    list.replaceChildren(el("div", { class: "file-row placeholder", text: message }));
  };

  // The "default" strategy label carries the rule Git's own config would
  // pick, so the user sees what a plain pull does before choosing it. The
  // read is best-effort: a failure leaves the neutral "Git default" text.
  const loadPullDefault = async (): Promise<void> => {
    const seq = ++pullDefaultSeq;
    try {
      const view = await invoke<PullDefault>("pull_default");
      if (seq !== pullDefaultSeq || currentSnapshot() === null) return;
      const option = strategySelect.options[0];
      option.textContent = `Git default (${view.effective})`;
      const configured = [
        view.rebase ? `pull.rebase=${view.rebase.value || "true"} (${view.rebase.scope})` : null,
        view.ff ? `pull.ff=${view.ff.value || "true"} (${view.ff.scope})` : null,
      ].filter((entry): entry is string => entry !== null);
      option.title = [
        configured.length > 0
          ? `Your config: ${configured.join(", ")}; effective: ${view.effective}.`
          : `No pull.rebase or pull.ff configured; effective: ${view.effective}.`,
        view.note ?? "",
      ].filter((part) => part !== "").join(" ");
    } catch {
      if (seq === pullDefaultSeq) strategySelect.options[0].textContent = "Git default";
    }
  };

  const load = async (): Promise<void> => {
    const seq = ++requestSeq;
    status.textContent = "Loading remotes…";
    try {
      const result = await invoke<RemoteView[]>("list_remotes");
      if (seq !== requestSeq) return;
      entries = result;
      renderPublishTargets(result);
      render();
      status.textContent = result.length === 0
        ? "No remotes configured."
        : `${result.length} remote${result.length === 1 ? "" : "s"} configured.`;
      void loadPullDefault();
    } catch (error) {
      if (seq !== requestSeq) return;
      deps.onError(error);
      placeholder("The remote list could not be loaded.");
    }
  };

  const sync = (): void => {
    if (currentSnapshot() === null) {
      if (syncedVersion !== -1) placeholder("Open a repository to list its remotes.");
      return;
    }
    if (snapshotVersion() === syncedVersion) return;
    syncedVersion = snapshotVersion();
    setForcePushReady(false);
    void load();
  };

  // --- events ---
  addButton.addEventListener("click", () => {
    const name = nameInput.value.trim();
    const url = urlInput.value.trim();
    if (name === "" || url === "") {
      setStatus("Enter both a remote name and a URL or local path.", "error");
      return;
    }
    void runRemoteWrite("add_remote", { name, url }, "Adding the remote…");
  });
  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); addButton.click(); }
  });
  fetchAllButton.addEventListener("click", () => void runFetch("all", "Fetching every remote…"));
  pullButton.addEventListener("click", () => {
    void runPull(strategySelect.value as "default" | "ffonly" | "merge" | "rebase");
  });
  pushButton.addEventListener("click", () => void runPush());
  publishButton.addEventListener("click", () => void runPublish());
  authRetryButton.addEventListener("click", () => consumeCredentialRetry()?.());
  forcePushButton.addEventListener("click", () => void deps.preview.request("forcePush", {}, null));

  return { descriptor: { id: "remotes", element }, sync, render, run };
}
