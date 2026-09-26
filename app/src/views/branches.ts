// Branches & Tags view.
//
// Names come from the backend's fixed-field for-each-ref protocol. Refs
// whose raw bytes do not round-trip through the display form are listed
// but flagged non-addressable, so no write action can ever target a
// look-alike ref name. Per the M7 density rule the everyday verbs (Switch
// for local branches) stay visible on the row; Merge, Rebase, Rename,
// Delete and Set upstream live in a per-row `⋯` menu, and every delete
// goes through the shared preview ticket.

import { invoke } from "@tauri-apps/api/core";
import { button, el, icon, openMenu, plural } from "../dom";
import {
  applySnapshot,
  currentSnapshot,
  isSessionActive,
  isWriteRunning,
  setStatus,
  setWriteRunning,
  snapshotVersion,
} from "../state";
import type {
  BranchRef,
  OperationResult,
  RefListing,
  RemoteRef,
  TagDetail,
  TagRef,
} from "../types";
import type { PreviewController } from "../dialogs/preview";

export interface BranchesDeps {
  preview: PreviewController;
  onError(error: unknown): void;
  getBranchStartOid(): string | null;
  getTagStartOid(): string | null;
  clearBranchStartOid(): void;
  clearTagStartOid(): void;
}

export interface BranchesView {
  descriptor: { id: "branches"; element: HTMLElement };
  sync(): void;
  render(): void;
  /** Reveals the separate force-delete confirmation after `git branch -d` refused. */
  offerForceDelete(name: string): void;
  /** Puts the caret in the branch or tag name field on the next render. */
  focusCreateField(): void;
}

export function createBranchesView(deps: BranchesDeps): BranchesView {
  const element = el("section", { class: "view-body branches-view" });

  const search = el("input", {
    class: "input search",
    type: "search",
    placeholder: "Filter branches and tags",
    "aria-label": "Filter branches and tags",
  });

  const branchName = el("input", { class: "input", type: "text", placeholder: "New branch name", "aria-label": "New branch name" });
  const branchCreate = el("button", { class: "btn", type: "button", text: "Create branch" });
  const branchForce = el("button", { class: "btn btn-danger", type: "button", text: "Force delete…", hidden: true });
  const createRow = el("div", { class: "create-row" }, [branchName, branchCreate, branchForce]);

  const tagName = el("input", { class: "input", type: "text", placeholder: "New tag name", "aria-label": "New tag name" });
  const tagMessage = el("input", { class: "input", type: "text", placeholder: "Annotation (optional)", "aria-label": "Tag annotation (optional)" });
  const tagCreate = el("button", { class: "btn", type: "button", text: "Create tag" });
  const tagRow = el("div", { class: "create-row" }, [tagName, tagMessage, tagCreate]);

  const list = el("div", { class: "ref-list", role: "list", "aria-label": "Branches and tags" });
  const status = el("span", { class: "view-status", role: "status" });
  element.append(
    el("div", { class: "view-tools" }, [search]),
    createRow,
    tagRow,
    status,
    list,
  );

  let requestSeq = 0;
  let syncedVersion = -1;
  let listing: RefListing | null = null;
  let renaming: string | null = null;
  let upstreamPickerFor: string | null = null;
  let branchForceTarget: string | null = null;
  let tagDetailFor: string | null = null;
  let filter = "";

  // Branch and tag writes share the backend write queue, so they ride the
  // same write lane as staging and committing; the fresh snapshot returned
  // by the backend flows through the standard version guard.
  const runBranch = async (
    command:
      | "create_branch"
      | "switch_branch"
      | "rename_branch"
      | "create_tag"
      | "merge_start"
      | "rebase_start"
      | "set_upstream",
    args: Record<string, unknown>,
    running: string,
  ): Promise<OperationResult | null> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isWriteRunning()) return null;
    setWriteRunning(true);
    setStatus(running, "progress");
    try {
      const result = await invoke<OperationResult>(command, { snapshotVersion: snapshot.version, ...args });
      applySnapshot(result.snapshot);
      setStatus(result.details ? `${result.message} ${result.details}` : result.message, "success");
      return result;
    } catch (error) {
      deps.onError(error);
      setStatus("The reference operation did not run.", "error");
      return null;
    } finally {
      setWriteRunning(false);
    }
  };

  const offerBranchForceDelete = (name: string): void => {
    branchForceTarget = name;
    branchForce.hidden = false;
    branchForce.textContent = `Force delete "${name}"…`;
  };
  const hideBranchForce = (): void => {
    branchForceTarget = null;
    branchForce.hidden = true;
  };

  const requestBranchDelete = (name: string, force: boolean): void => {
    void deps.preview.request("branch", { name, force }, null);
  };

  // --- upstream picker ---
  const setUpstream = async (branch: string, upstream: string | null): Promise<void> => {
    const result = await runBranch(
      "set_upstream",
      { branch, upstream },
      upstream ? `Setting upstream of ${branch}…` : `Clearing upstream of ${branch}…`,
    );
    if (result) upstreamPickerFor = null;
    render();
  };

  // --- tag detail ---
  const tagDetailPanel = el("div", { class: "tag-detail", hidden: true });
  const tagDetailMeta = el("dl", { class: "detail-meta" });
  const tagDetailMessage = el("pre", { class: "commit-message" });
  const tagDetailClose = el("button", { class: "btn", type: "button", text: "Close" });
  tagDetailPanel.append(tagDetailMeta, tagDetailMessage, tagDetailClose);
  element.append(tagDetailPanel);

  const showTagDetail = (name: string): void => {
    void (async () => {
      setStatus(`Reading tag ${name}…`);
      try {
        const detail = await invoke<TagDetail>("show_tag", { name });
        const row = (term: string, value: string): HTMLElement[] => [el("dt", { text: term }), el("dd", { text: value })];
        tagDetailMeta.replaceChildren(
          ...row("Tag", detail.name),
          ...row("Type", detail.annotated ? "annotated" : "lightweight"),
          ...row("Tag object", detail.oid),
          ...row("Commit", detail.targetOid),
        );
        tagDetailMessage.textContent = detail.annotated
          ? detail.message
          : "Lightweight tag — it names the commit directly and carries no annotation.";
        tagDetailPanel.hidden = false;
        tagDetailFor = name;
        setStatus(`Tag ${detail.name} (${detail.annotated ? "annotated" : "lightweight"}).`, "success");
      } catch (error) {
        deps.onError(error);
        setStatus("The tag could not be read.", "error");
      }
    })();
  };
  tagDetailClose.addEventListener("click", () => {
    tagDetailPanel.hidden = true;
    tagDetailFor = null;
  });

  // --- context menu ---

  // --- rendering ---
  const refRow = (badge: string, name: string, meta: string, addressable: boolean): HTMLElement => {
    const element = el("div", { class: "file-row ref-row", role: "listitem" });
    if (badge) element.append(el("span", { class: "file-status", text: badge }));
    const label = el("span", { class: "ref-name", text: name, title: name });
    if (!addressable) {
      label.classList.add("inert-ref");
      label.title = "This ref name is not byte-round-trippable; shown read-only.";
    }
    element.append(label);
    if (meta) element.append(el("span", { class: "ref-meta", text: meta, title: meta }));
    return element;
  };

  const moreButton = (label: string, items: Array<{ label: string; run: () => void; danger?: boolean }>): HTMLElement => {
    const more = el("button", { class: "row-more", type: "button", "aria-label": `More actions for ${label}` }, [icon("more", 14)]);
    more.disabled = isWriteRunning();
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu(more, items);
    });
    return more;
  };

  const buildUpstreamPicker = (branch: BranchRef): HTMLElement => {
    const group = el("div", { class: "file-row ref-row upstream-picker", role: "group", "aria-label": `Choose upstream for ${branch.name}` });
    group.append(el("span", { class: "ref-name", text: `Upstream for ${branch.name}:` }));
    // M5-02: the picker lists only addressable, non-symbolic remote-tracking
    // refs from the last read listing; the backend re-verifies both sides
    // against its own fresh listing before Git runs.
    const candidates = (listing?.remotes ?? []).filter((remote) => remote.addressable && remote.symref === null);
    if (candidates.length === 0) {
      group.append(el("span", { class: "ref-meta", text: "no fetched remote branches — run a fetch first" }));
    }
    for (const remote of candidates) {
      group.append(button(remote.name, () => void setUpstream(branch.name, remote.name), { class: "row-action" }));
    }
    if (branch.upstream) {
      group.append(button("No upstream", () => void setUpstream(branch.name, null), { class: "row-action" }));
    }
    group.append(button("Cancel", () => { upstreamPickerFor = null; render(); }, { class: "row-action" }));
    return group;
  };

  const matchesFilter = (name: string): boolean => filter === "" || name.toLowerCase().includes(filter);

  const renderBranches = (branches: BranchRef[]): HTMLElement[] => {
    const rows: HTMLElement[] = [el("div", { class: "ref-heading", text: `Branches (${branches.length})` })];
    for (const branch of branches) {
      if (!matchesFilter(branch.name)) continue;
      const parts: string[] = [];
      if (branch.upstream) parts.push(`→ ${branch.upstream}`);
      if (branch.upstreamGone) parts.push("upstream gone");
      if (branch.ahead !== null) parts.push(`↑${branch.ahead}`);
      if (branch.behind !== null) parts.push(`↓${branch.behind}`);
      const element = refRow(branch.head ? "●" : "", branch.name, parts.join("  "), branch.addressable);
      // Only byte-round-trippable names can be write targets (plan/04); the
      // checked-out branch can be renamed but never switched away or deleted.
      if (branch.addressable && renaming === branch.name) {
        element.classList.add("renaming");
        const input = el("input", { class: "input ref-rename", type: "text", value: branch.name, "aria-label": `New name for ${branch.name}` });
        const cancel = button("Cancel", () => { renaming = null; render(); }, { class: "row-action" });
        const save = button("Save", () => {
          const next = input.value.trim();
          if (!next || next === branch.name) { renaming = null; render(); return; }
          void runBranch("rename_branch", { old: branch.name, new: next }, `Renaming ${branch.name}…`).then(() => { renaming = null; render(); });
        }, { class: "row-action" });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); save.click(); }
          else if (event.key === "Escape") { event.preventDefault(); cancel.click(); }
        });
        element.append(input, save, cancel);
      } else if (branch.addressable) {
        if (!branch.head) {
          element.append(button("Switch", () => void runBranch("switch_branch", { name: branch.name }, `Switching to ${branch.name}…`), { class: "row-action" }));
        }
        element.append(
          moreButton(branch.name, [
            // Merges never touch the source branch and rebases are explicit
            // per-click actions; the backend still refuses both while any
            // operation is in progress.
            ...(!branch.head
              ? [
                  { label: "Merge into current", run: () => void runBranch("merge_start", { target: branch.name }, `Merging ${branch.name}…`) },
                  { label: "Rebase onto…", run: () => void runBranch("rebase_start", { target: branch.name }, `Rebasing the current branch onto ${branch.name}…`), danger: true },
                ]
              : []),
            { label: "Rename…", run: () => { renaming = branch.name; render(); } },
            ...(!branch.head ? [{ label: "Delete…", run: () => requestBranchDelete(branch.name, false), danger: true }] : []),
            { label: "Set upstream…", run: () => { upstreamPickerFor = upstreamPickerFor === branch.name ? null : branch.name; render(); } },
          ]),
        );
      }
      rows.push(element);
      if (upstreamPickerFor === branch.name) rows.push(buildUpstreamPicker(branch));
    }
    return rows;
  };

  const renderRemoteBranches = (remotes: RemoteRef[]): HTMLElement[] => {
    const rows: HTMLElement[] = [el("div", { class: "ref-heading", text: `Remote branches (${remotes.length})` })];
    for (const remote of remotes) {
      if (!matchesFilter(remote.name)) continue;
      const meta = remote.symref ? `symref → ${remote.symref}` : remote.oid.slice(0, 8);
      const element = refRow("", remote.name, meta, remote.addressable);
      // Deletable targets are real remote branches only: the symbolic
      // default-branch marker and irreversibly named refs stay read-only.
      if (remote.addressable && remote.symref === null) {
        element.append(
          moreButton(remote.name, [
            { label: "Delete on remote…", run: () => void deps.preview.request("remoteBranchDelete", { target: remote.name }, null), danger: true },
          ]),
        );
      }
      rows.push(element);
    }
    return rows;
  };

  const renderTags = (tags: TagRef[]): HTMLElement[] => {
    const rows: HTMLElement[] = [el("div", { class: "ref-heading", text: `Tags (${tags.length})` })];
    for (const tag of tags) {
      if (!matchesFilter(tag.name)) continue;
      const target = tag.targetOid ?? tag.oid;
      const element = refRow(
        tag.annotated ? "T" : "",
        tag.name,
        `${tag.annotated ? "annotated" : "lightweight"} → ${target.slice(0, 8)}`,
        tag.addressable,
      );
      // View reads the annotation through the backend's exact-ref query;
      // delete goes through the same preview ticket flow as branches (tags
      // have no force stage — `git tag -d` only removes the name).
      if (tag.addressable) {
        element.append(
          moreButton(tag.name, [
            { label: "View annotation", run: () => showTagDetail(tag.name) },
            { label: "Delete…", run: () => void deps.preview.request("tag", { name: tag.name }, null), danger: true },
          ]),
        );
      }
      rows.push(element);
    }
    return rows;
  };

  const placeholder = (message: string): void => {
    listing = null;
    renaming = null;
    upstreamPickerFor = null;
    hideBranchForce();
    tagDetailPanel.hidden = true;
    status.textContent = "";
    list.replaceChildren(el("div", { class: "file-row placeholder", text: message }));
  };

  // --- lifecycle ---
  // Arriving from History with a chosen start point puts the caret in the
  // name field, so the user can type straight away.
  let focusName = false;

  const render = (): void => {
    const locked = !isSessionActive() || isWriteRunning();
    branchName.disabled = locked;
    branchCreate.disabled = locked || branchName.value.trim() === "";
    tagName.disabled = locked;
    tagMessage.disabled = locked;
    tagCreate.disabled = locked || tagName.value.trim() === "";
    // Focus the create field even before the list lands, so a keyboard user
    // can start typing the moment they arrive from History.
    if (focusName && !locked) {
      focusName = false;
      (deps.getBranchStartOid() === null ? tagName : branchName).focus();
    }
    if (listing === null) return;
    const branches = listing.branches.filter((branch) => matchesFilter(branch.name));
    list.replaceChildren(
      ...renderBranches(listing.branches),
      ...renderRemoteBranches(listing.remotes),
      ...renderTags(listing.tags),
    );
    status.textContent = `${plural(branches.length, "branch")} shown, ${plural(listing.remotes.length, "remote ref")}, ${plural(listing.tags.length, "tag")}.`;
  };

  const load = async (): Promise<void> => {
    const seq = ++requestSeq;
    status.textContent = "Loading references…";
    try {
      const result = await invoke<RefListing>("list_refs");
      if (seq !== requestSeq) return; // a newer request took over
      listing = result;
      render();
      status.textContent = `${plural(result.branches.length, "branch")}, ${plural(result.remotes.length, "remote ref")}, ${plural(result.tags.length, "tag")}.`;
    } catch (error) {
      if (seq !== requestSeq) return;
      deps.onError(error);
      placeholder("The ref listing could not be loaded.");
    }
  };

  // Driven from renderSnapshot: every newly accepted snapshot version
  // re-reads refs once (writes, watcher and focus refreshes all flow through
  // there); a re-render of the same version never touches Git.
  const sync = (): void => {
    if (currentSnapshot() === null) {
      if (syncedVersion !== -1) placeholder("Open a repository to list its branches and tags.");
      return;
    }
    if (snapshotVersion() === syncedVersion) return;
    syncedVersion = snapshotVersion();
    void load();
  };

  // --- events ---
  search.addEventListener("input", () => {
    filter = search.value.trim().toLowerCase();
    render();
  });
  branchName.addEventListener("input", () => render());
  tagName.addEventListener("input", () => render());
  branchName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); branchCreate.click(); }
  });
  tagName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); tagCreate.click(); }
  });
  branchCreate.addEventListener("click", () => {
    const name = branchName.value.trim();
    if (!name || isWriteRunning()) return;
    const startOid = deps.getBranchStartOid();
    void runBranch("create_branch", startOid ? { name, startOid } : { name }, `Creating branch ${name}…`).then((result) => {
      if (result?.outcome === "success") {
        branchName.value = "";
        // The chosen start point applies to one branch only; a later create
        // must start from HEAD again.
        deps.clearBranchStartOid();
      }
      render();
    });
  });
  branchForce.addEventListener("click", () => {
    if (branchForceTarget === null) return;
    const name = branchForceTarget;
    hideBranchForce();
    requestBranchDelete(name, true);
  });
  tagCreate.addEventListener("click", () => {
    const name = tagName.value.trim();
    if (!name || isWriteRunning()) return;
    const annotation = tagMessage.value.trim();
    void runBranch(
      "create_tag",
      { name, targetOid: deps.getTagStartOid(), message: annotation === "" ? null : annotation },
      `Creating tag ${name}…`,
    ).then((result) => {
      if (result?.outcome === "success") {
        tagName.value = "";
        tagMessage.value = "";
        // As with branches, the chosen commit applies to one tag only.
        deps.clearTagStartOid();
      }
      render();
    });
  });

  return {
    descriptor: { id: "branches", element },
    sync,
    render,
    offerForceDelete: offerBranchForceDelete,
    focusCreateField: () => { focusName = true; },
  };
}
