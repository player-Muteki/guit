// Settings view: General, External tools, Environment & diagnostics and
// Developer. The environment probes (git/tool/window checks, the
// compact-window test, the diagnostics export manifest, the process probe)
// live here so the everyday views stay focused on the Git
// workflow. Theme follows the
// system by default; the selector is stored in localStorage and applied as
// a `data-theme` attribute on <html>. The refresh interval of the age line is a
// row on this page, but the timer it changes belongs to the panel drawing that
// line — this view asks, that panel re-arms its one interval.

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { button, el, icon, plural } from "../dom";
import { createConfirmDialog, type ConfirmRequest } from "../dialogs/confirm";
import { isAlwaysOnTop, isRestoreEnabled, setAlwaysOnTop, compactWindow, restoreWindowSize, windowGeometry } from "../window";
import { currentFontPx, applyFontPx, FONT_DEFAULT } from "../font";
import { INTERVAL_MAX, INTERVAL_MIN } from "../activityModel";
import type { IntervalApplied } from "../activityModel";
import type { GitProbe, ToolProbe } from "../types";

export interface SettingsDeps {
  onError(error: unknown): void;
  /** The age line's refresh period, which belongs to the panel that holds its
   * timer rather than to this page. */
  currentInterval(): number;
  applyInterval(requested: string | number): IntervalApplied;
}

export interface SettingsView {
  descriptor: { id: "settings"; element: HTMLElement };
  render(): void;
  noteGeometry(text: string): void;
}

export function createSettingsView(deps: SettingsDeps): SettingsView {
  // `document-view`: this body is prose and controls, not a list of scrollers,
  // so it scrolls as a whole and its sections keep their natural height.
  const element = el("section", { class: "view-body settings-view document-view" });

  // --- appearance ---
  const themeSelect = el("select", { class: "input", "aria-label": "Theme" }, [
    el("option", { value: "system", text: "Follow system" }),
    el("option", { value: "light", text: "Light" }),
    el("option", { value: "dark", text: "Dark" }),
  ]);
  // `role="status"`: a bare <span> written from script gets no accessible
  // object in WebKitGTK, and the size readout is only useful if it is
  // announced when the zoom buttons change it.
  const zoomLabel = el("span", { class: "setting-value", role: "status" });
  const onTopToggle = el("input", { type: "checkbox", id: "settings-on-top" });
  const onTopLabel = el("label", { class: "checkbox", for: "settings-on-top" }, [onTopToggle, el("span", { text: "Always on top" })]);
  // The refresh period of the one sentence that ages on its own. The timer it
  // changes is not this page's: it belongs to the panel drawing the line, which is
  // what keeps the panel down to a single repeating timer however often this row
  // is used.
  const intervalInput = el("input", {
    class: "input",
    type: "number",
    "aria-label": "Last-modified text refresh, in seconds",
  });
  intervalInput.min = String(INTERVAL_MIN);
  intervalInput.max = String(INTERVAL_MAX);
  intervalInput.step = "1";
  const intervalNote = el("p", { class: "setting-note", role: "status" });
  const general = el("section", { class: "view-block" }, [
    el("h2", { class: "block-title" }, [icon("settings"), el("span", { text: "General" })]),
    el("div", { class: "setting-row" }, [el("span", { class: "setting-label", text: "Theme" }), themeSelect]),
    el("div", { class: "setting-row" }, [
      el("span", { class: "setting-label", text: "Interface zoom" }),
      el("div", { class: "zoom-controls" }, [
        button("−", () => applyFontPx(currentFontPx() - 1), { class: "btn tiny", ariaLabel: "Zoom out" }),
        zoomLabel,
        button("+", () => applyFontPx(currentFontPx() + 1), { class: "btn tiny", ariaLabel: "Zoom in" }),
        button("Reset", () => applyFontPx(FONT_DEFAULT), { class: "btn tiny", ariaLabel: "Reset zoom" }),
      ]),
    ]),
    el("div", { class: "setting-row" }, [
      el("span", { class: "setting-label", text: "Last-modified text" }),
      el("div", { class: "zoom-controls" }, [intervalInput, el("span", { class: "setting-value", text: "seconds" })]),
    ]),
    intervalNote,
    el("div", { class: "setting-row" }, [onTopLabel]),
    el("div", { class: "setting-row" }, [
      el("span", { class: "setting-label", text: "Shortcuts" }),
      el("dl", { class: "shortcut-list" }, [
        el("dt", { text: "Ctrl/Cmd + O" }), el("dd", { text: "Open repository" }),
        el("dt", { text: "Ctrl/Cmd + R" }), el("dd", { text: "Refresh status" }),
        el("dt", { text: "Ctrl/Cmd + 1 / 2" }), el("dd", { text: "Main page / Settings" }),
        el("dt", { text: "↑ / ↓ / Page keys" }), el("dd", { text: "Resize Main's split (divider focused)" }),
        el("dt", { text: "Ctrl/Cmd + Enter" }), el("dd", { text: "Commit (from the message box)" }),
        el("dt", { text: "Ctrl/Cmd + = / − / 0" }), el("dd", { text: "Interface zoom in / out / reset" }),
        el("dt", { text: "Escape" }), el("dd", { text: "Close a dialog, menu or layer" }),
      ]),
    ]),
  ]);

  // --- environment ---
  const gitResult = el("dd", { text: "Checking…" });
  const toolsResult = el("dd", { text: "Checking…" });
  const windowResult = el("dd", { text: "Checking…" });
  const folderResult = el("dd", { text: "Not tested" });
  const diagnosticsStatus = el("p", { class: "setting-note", role: "status" });
  const compactButton = button("Test compact window", async () => {
    try {
      await compactWindow();
      windowResult.textContent = await windowGeometry();
    } catch (error) {
      deps.onError(error);
    }
  }, { class: "btn" });
  const restoreButton = button("Restore window size", async () => {
    try {
      await restoreWindowSize();
      windowResult.textContent = await windowGeometry();
    } catch (error) {
      deps.onError(error);
    }
  }, { class: "btn" });
  const exportButton = button("Export diagnostics…", () => confirm.show(exportRequest), { class: "btn" });
  const environment = el("section", { class: "view-block" }, [
    el("h2", { class: "block-title" }, [icon("check"), el("span", { text: "Environment & diagnostics" })]),
    el("dl", { class: "setting-facts" }, [
      el("dt", { text: "Git" }), gitResult,
      el("dt", { text: "External tools" }), toolsResult,
      el("dt", { text: "Window" }), windowResult,
      el("dt", { text: "Folder picker" }), folderResult,
    ]),
    el("div", { class: "view-tools" }, [
      button("Check again", () => void refresh(), { class: "btn" }),
      button("Choose folder", async () => {
        try {
          const selected = await open({ directory: true, multiple: false });
          folderResult.textContent = selected ?? "Selection cancelled";
        } catch (error) {
          deps.onError(error);
        }
      }, { class: "btn" }),
    ]),
    el("div", { class: "view-tools" }, [compactButton, restoreButton, exportButton]),
    diagnosticsStatus,
  ]);

  // --- developer ---
  const probeResult = el("p", { class: "setting-note", role: "status", text: "Idle" });
  const runProbeButton = el("button", { class: "btn", type: "button", text: "Run probe" });
  const cancelProbeButton = el("button", { class: "btn", type: "button", text: "Cancel probe", disabled: true });
  // Environment facts are probed once, the first time the view is opened.
  let probed = false;
  const developer = el("section", { class: "view-block" }, [
    el("h2", { class: "block-title" }, [icon("branch"), el("span", { text: "Developer" })]),
    el("p", { class: "setting-note", text: "Starts a cancellable Git command to verify that the window stays responsive." }),
    el("div", { class: "view-tools" }, [runProbeButton, cancelProbeButton]),
    probeResult,
  ]);

  element.append(general, environment, developer);

  // --- diagnostics export (the manifest is the confirmation) ---
  const confirm = createConfirmDialog();
  document.body.append(confirm.element);
  confirm.onConfirm(() => void doExport());
  const exportRequest: ConfirmRequest = {
    kind: "diagnostics",
    candidates: [
      "App, OS and Git versions, and the Git executable location (home folder shown as ~)",
      "The filesystem-watch mode",
      "Config file names, sizes and schema versions — never their contents",
      "The 256 most recent event summaries: phase timings, error codes and messages",
    ],
    dropped: [
      "passwords",
      "tokens",
      "credential configuration",
      "remotes and their URLs",
      "prompts",
      "commit messages",
      "file contents",
      "repository paths",
    ],
    targetOid: null,
    warning: "guit will write a plain-text diagnostics report to a file you choose. It contains:",
    confirm: "Export…",
    cancel: "Cancel",
    droppedLabel: "Never included",
  };
  const doExport = async (): Promise<void> => {
    diagnosticsStatus.textContent = "";
    try {
      const selected = await save({ defaultPath: "guit-diagnostics.txt" });
      if (typeof selected !== "string") return; // dialog cancelled
      const fileName = await invoke<string>("export_diagnostics", { path: selected });
      diagnosticsStatus.textContent = `Diagnostics written to ${fileName}.`;
    } catch (error) {
      deps.onError(error);
    }
  };

  // --- refresh ---
  const refresh = async (): Promise<void> => {
    const results = await Promise.allSettled([
      invoke<GitProbe>("probe_git"),
      invoke<ToolProbe>("probe_external_tools"),
      windowGeometry(),
    ]);
    const [git, tools, geometry] = results;
    if (git.status === "fulfilled") {
      const value = git.value;
      // The backend owns this sentence, so the view shows it verbatim instead
      // of keeping a second copy that can disagree with the first.
      gitResult.textContent = `${value.version ?? "Git"} · ${value.message}`;
    } else deps.onError(git.reason);
    if (tools.status === "fulfilled") {
      toolsResult.textContent = `Diff: ${tools.value.difftool ?? "not configured"}; Merge: ${tools.value.mergetool ?? "not configured"}; File opener: ${tools.value.opener}`;
    } else deps.onError(tools.reason);
    if (geometry.status === "fulfilled") windowResult.textContent = geometry.value;
    else deps.onError(geometry.reason);
  };

  runProbeButton.addEventListener("click", async () => {
    runProbeButton.disabled = true;
    cancelProbeButton.disabled = false;
    probeResult.textContent = "Running…";
    try {
      probeResult.textContent = await invoke<string>("run_process_probe");
    } catch (error) {
      deps.onError(error);
      probeResult.textContent = "Probe failed";
    } finally {
      runProbeButton.disabled = false;
      cancelProbeButton.disabled = true;
    }
  });
  cancelProbeButton.addEventListener("click", async () => {
    try {
      await invoke("cancel_process_probe");
      probeResult.textContent = "Cancellation requested; checking final state…";
    } catch (error) {
      deps.onError(error);
    }
  });
  // --- events ---
  themeSelect.addEventListener("change", () => {
    const value = themeSelect.value;
    try {
      if (value === "system") {
        localStorage.removeItem("guit.theme");
        document.documentElement.removeAttribute("data-theme");
      } else {
        localStorage.setItem("guit.theme", value);
        document.documentElement.setAttribute("data-theme", value);
      }
    } catch {
      // Storage may be unavailable; the attribute still applies this session.
    }
  });
  onTopToggle.addEventListener("change", async () => {
    try {
      await setAlwaysOnTop(onTopToggle.checked);
    } catch (error) {
      onTopToggle.checked = !onTopToggle.checked;
      deps.onError(error);
    }
  });

  // The field ends up showing the number the panel actually runs on. A value the
  // range will not take is written back to its bound instead of being left in the
  // box, because a row reading 200 while the line updates every 60 seconds is a row
  // that has started lying, and only one of those two numbers can be true.
  intervalInput.addEventListener("change", () => {
    const applied = deps.applyInterval(intervalInput.value);
    intervalInput.value = String(applied.seconds);
    if (applied.refused) {
      intervalNote.textContent = `Enter a number of seconds between ${INTERVAL_MIN} and ${INTERVAL_MAX}; the interval stays at ${applied.seconds}.`;
      return;
    }
    // Which bound was hit is worth saying, and the two readings of "the number you
    // typed is not usable" are not the same complaint: one is a range, the other is
    // that half a second has no meaning to a display.
    const bound = applied.seconds === INTERVAL_MIN
      ? "quickest"
      : applied.seconds === INTERVAL_MAX ? "slowest" : null;
    const stated = plural(applied.seconds, "second");
    if (applied.corrected) {
      intervalNote.textContent = bound === null
        ? `${stated} — the interval counts whole seconds.`
        : `${stated} is the ${bound} this line can be set to.`;
    } else if (!applied.persisted) {
      intervalNote.textContent = `${stated} for this session — guit could not save it.`;
    } else {
      intervalNote.textContent = "";
    }
  });

  const render = (): void => {
    onTopToggle.checked = isAlwaysOnTop();
    restoreButton.disabled = !isRestoreEnabled();
    const zoom = `${currentFontPx()}px`;
    if (zoomLabel.textContent !== zoom) zoomLabel.textContent = zoom;
    themeSelect.value = document.documentElement.getAttribute("data-theme") ?? "system";
    // The in-force interval, unless the caret is in the box: this view is redrawn
    // whenever the repository behind it changes, and a watcher event landing
    // mid-edit would otherwise type over the number being written.
    if (document.activeElement !== intervalInput) intervalInput.value = String(deps.currentInterval());
    if (!probed) {
      probed = true;
      void refresh();
    }
  };

  const noteGeometry = (text: string): void => {
    windowResult.textContent = text;
  };

  return { descriptor: { id: "settings", element }, render, noteGeometry };
}
