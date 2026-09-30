// Branches & Tags view.
//
// Names come from the backend's fixed-field for-each-ref protocol. Refs
// whose raw bytes do not round-trip through the display form are listed
// but flagged non-addressable, so no write action can ever target a
// look-alike ref name. By the density rule the everyday verbs (Switch
// for local branches) stay visible on the row; Merge, Rebase, Rename and
// Delete live in a per-row `⋯` menu, and every delete goes through the shared
// preview ticket.

import { invoke } from "@tauri-apps/api/core";
import { button, el, icon, openMenu, plural } from "../dom";
import { branchDetail } from "../headModel";
import { readRefListing } from "../refsStore";
import { contextMatches, readContextFor } from "../snapshotBus";
import {
  applySnapshot,
  currentSnapshot,
  isSessionActive,
  isWriteRunning,
  setStatus,
  setWriteRunning,
} from "../state";
import type {
  BranchRef,
  OperationResult,
  ReadContext,
  RefListing,
  RemoteRef,
  SessionRead,
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
  element: HTMLElement;
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
  // The refs context the listing on screen was asked for. One number per
  // session, minted by the backend, replaces the snapshot version this view
  // used to compare: a refresh that leaves the names alone must not re-read,
  // and opening a second clone of the same repository must.
  let syncedContext: ReadContext | null = null;
  let listing: RefListing | null = null;
  let renaming: string | null = null;
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
      | "rebase_start",
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
      setStatus(result.details ? `${result.message} ${result.details}` : result.message, result.outcome === "success" ? "success" : "error");
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

  // --- tag detail ---
  const tagDetailPanel = el("div", { class: "tag-detail", hidden: true });
  const tagDetailMeta = el("dl", { class: "detail-meta" });
  const tagDetailMessage = el("pre", { class: "commit-message" });
  const tagDetailClose = el("button", { class: "btn", type: "button", text: "Close" });
  tagDetailPanel.append(tagDetailMeta, tagDetailMessage, tagDetailClose);
  element.append(tagDetailPanel);

  const showTagDetail = (name: string): void => {
    // The row was drawn from this context, so the annotation is asked for as
    // it too. A picker that has since moved on gets an answer it drops.
    const asked = syncedContext;
    if (asked === null) return;
    void (async () => {
      setStatus(`Reading tag ${name}…`);
      try {
        const read = await invoke<SessionRead<TagDetail>>("show_tag", { context: asked, name });
        if (syncedContext === null || !contextMatches(asked, syncedContext)) return;
        if (!contextMatches(asked, read.context)) return;
        const detail = read.value;
        const row = (term: string, value: string): HTMLElement[] => [el("dt", { text: term }), el("dd", { text: value })];
        tagDetailMeta.replaceChildren(
          ...row("Tag", detail.name),
          ...row("Type", detail.annotated ? "annotated" : "lightweight"),
          ...row("Tag object", detail.oid),
          // A tag is not assumed to name a commit, because it may not. When it
          // names something else, what it names is the whole answer.
          ...(detail.commitOid === null
            ? row("Names", `a ${detail.targetType}, not a commit`)
            : row("Commit", detail.commitOid)),
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

  const matchesFilter = (name: string): boolean => filter === "" || name.toLowerCase().includes(filter);

  const renderBranches = (branches: BranchRef[]): HTMLElement[] => {
    const rows: HTMLElement[] = [el("div", { class: "ref-heading", text: `Branches (${branches.length})` })];
    for (const branch of branches) {
      if (!matchesFilter(branch.name)) continue;
      const parts = branchDetail(branch);
      const element = refRow(branch.head ? "●" : "", branch.name, parts, branch.addressable);
      // Only byte-round-trippable names can be write targets; the
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
          ]),
        );
      }
      rows.push(element);
    }
    return rows;
  };

  const renderRemoteBranches = (remotes: RemoteRef[]): HTMLElement[] => {
    // Remote-tracking refs are shown as the local metadata they are: the last
    // state Git recorded, with no entry point that could change the remote
    // itself. The symbolic default-branch marker and names that do not
    // round-trip are marked the same way either way.
    const rows: HTMLElement[] = [el("div", { class: "ref-heading", text: `Remote branches (${remotes.length})` })];
    for (const remote of remotes) {
      if (!matchesFilter(remote.name)) continue;
      const meta = remote.symref ? `symref → ${remote.symref}` : remote.oid.slice(0, 8);
      rows.push(refRow("", remote.name, meta, remote.addressable));
    }
    return rows;
  };

  const renderTags = (tags: TagRef[]): HTMLElement[] => {
    const rows: HTMLElement[] = [el("div", { class: "ref-heading", text: `Tags (${tags.length})` })];
    for (const tag of tags) {
      if (!matchesFilter(tag.name)) continue;
      // What the tag names, peeled by the backend: a commit gives its id, and a
      // tag on anything else says what kind of object it points at rather than
      // implying a commit that is not there.
      const target =
        tag.commitOid === null
          ? `${tag.targetType} ${tag.oid.slice(0, 8)}`
          : tag.commitOid.slice(0, 8);
      const element = refRow(
        tag.annotated ? "T" : "",
        tag.name,
        `${tag.annotated ? "annotated" : "lightweight"} → ${target}`,
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

  const load = async (asked: ReadContext): Promise<void> => {
    const seq = ++requestSeq;
    status.textContent = "Loading references…";
    try {
      // The shared names read: the graph is labelled from the same listing, and
      // one generation of names is one read however many views draw it.
      const read = await readRefListing(asked);
      // Both halves: a newer request in this view took over, and the answer
      // has to come back under the context it was asked for. The second one is
      // what drops a listing of the repository the user already left behind.
      if (seq !== requestSeq) return;
      if (syncedContext === null || !contextMatches(asked, syncedContext)) return;
      if (!contextMatches(asked, read.context)) return;
      const result = read.value;
      listing = result;
      render();
      status.textContent = `${plural(result.branches.length, "branch")}, ${plural(result.remotes.length, "remote ref")}, ${plural(result.tags.length, "tag")}.`;
    } catch (error) {
      if (seq !== requestSeq) return;
      if (syncedContext === null || !contextMatches(asked, syncedContext)) return;
      deps.onError(error);
      placeholder("The ref listing could not be loaded.");
    }
  };

  // The picker reads the names when it opens, and again when a snapshot moves
  // the refs it is showing. The backend's refs generation is what keeps those
  // two triggers down to one read per move; a re-render never touches Git. The
  // commit graph asks for the same listing on the same counter, and the shared
  // read behind it means the two views cost one Git process between them.
  const sync = (): void => {
    const snapshot = currentSnapshot();
    if (snapshot === null) {
      // Clear before checking: an in-flight read must find nothing to return
      // to, or a closed session would keep showing its branches.
      if (syncedContext !== null) placeholder("Open a repository to list its branches and tags.");
      // The context and the names it described clear together, so a later
      // filter keystroke cannot repaint a closed session's refs.
      syncedContext = null;
      listing = null;
      return;
    }
    const context = readContextFor(snapshot, "refs");
    if (syncedContext !== null && contextMatches(syncedContext, context)) return;
    syncedContext = context;
    void load(context);
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
    element,
    sync,
    render,
    offerForceDelete: offerBranchForceDelete,
    focusCreateField: () => { focusName = true; },
  };
}
