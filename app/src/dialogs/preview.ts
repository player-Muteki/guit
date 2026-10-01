// The single-use ticket flow shared by every destructive action
// preview → recheck → confirm.
//
// One controller owns the pending ticket, the modal dialog and the renew
// hook. A newer snapshot invalidates file IDs, so while a ticket is open
// every accepted snapshot re-requests the preview against fresh Git state;
// a changed candidate set is surfaced verbatim and the user must confirm
// again. A ticket that was asked about files renews by turning the names it
// showed back into ids of the new snapshot, which is the only handle they still
// have; a ticket that was asked about the repository as a whole restates itself
// the same way it was first asked. A clean restore is asked about a commit, so it
// restates itself by the text that was typed and shows the six classes of path its
// ticket binds as six sections rather than one list. The confirm event carries the
// ticket's `kind` and `nonce`; the owning view maps the kind to its backend command
// and only ever sends `{ nonce }`.

import { invoke } from "@tauri-apps/api/core";
import { cleanEligible, discardEligible, idsForNames } from "../fileModel";
import { restoreReading } from "../restoreModel";
import {
  applySnapshot,
  currentSnapshot,
  isWriteRunning,
  pendingPreview,
  setPendingPreview,
  setStatus,
  type PendingPreview,
} from "../state";
import type { FileView, PreviewCopy, PreviewKindKey, PreviewResult, RestorePreviewResult } from "../types";
import { createConfirmDialog, type ConfirmDialog, type ConfirmNames } from "./confirm";

const previewCopy: Record<PreviewKindKey, PreviewCopy> = {
  discard: {
    warning: "Discarding reverts these files in the working copy. The uncommitted work-tree changes cannot be recovered.",
    confirm: "Discard",
    cancel: "Keep changes",
  },
  clean: {
    warning: "These untracked files and folders will be deleted from disk. They are not in Git and cannot be recovered.",
    confirm: "Delete untracked",
    cancel: "Keep files",
    // A scoped clean can be handed a path Git will not remove — a tracked file,
    // an ignored one, a repository of its own — and the fallback line in the
    // dialog explains that as a work-tree fact, which is a discard's reason, not
    // a clean's.
    droppedLabel: "Not removed (a clean takes untracked files only)",
  },
  branch: {
    warning:
      "Deleting removes this branch name. Commits it points at stay reachable only through other refs; once unreachable, Git may garbage-collect them. This cannot be undone from guit.",
    confirm: "Delete branch",
    cancel: "Keep branch",
  },
  tag: {
    warning:
      "Deleting removes this tag name. If the tagged commit is reachable from no branch or other ref, Git may garbage-collect it. This cannot be undone from guit.",
    confirm: "Delete tag",
    cancel: "Keep tag",
  },
  stashDrop: {
    warning:
      "Deleting discards this stashed snapshot permanently. Its commits become unreachable and Git may garbage-collect them. This cannot be undone from guit.",
    confirm: "Delete stash",
    cancel: "Keep stash",
  },
  stashPop: {
    warning:
      "Popping re-applies these changes to the working copy and discards the stash entry. If the apply conflicts, Git keeps the entry and reports a failure.",
    confirm: "Pop stash",
    cancel: "Keep entry",
  },
  restore: {
    warning:
      "A clean restore moves this branch to the selected commit, overwrites the listed changes, and deletes the listed untracked files. Every path below is one the restore touches, each by a different step. The commits it leaves behind become unreachable and Git may garbage-collect them; a path guit does not enter stays on disk. This cannot be undone from guit.",
    confirm: "Restore to clean state",
    cancel: "Keep everything",
  },
  worktreeRemove: {
    warning:
      "Removing unregisters this linked worktree and deletes its Git metadata link. guit never forces: if the worktree has uncommitted work, Git itself refuses and nothing is removed.",
    confirm: "Remove worktree",
    cancel: "Keep worktree",
  },
};

const branchForceCopy: PreviewCopy = {
  warning:
    "This branch is not fully merged. Force-deleting makes its unique commits unreachable, and Git may garbage-collect them. This cannot be undone from guit.",
  confirm: "Force delete branch",
  cancel: "Keep branch",
};

export interface PreviewController {
  readonly dialog: ConfirmDialog;
  request(kind: PreviewKindKey, args: Record<string, unknown>, files: readonly FileView[] | null): Promise<void>;
  close(message?: string): void;
  onConfirm(handler: (pending: PendingPreview) => void): void;
  /** Re-requests the open ticket against a fresh snapshot; call after every accepted snapshot. */
  renew(): Promise<void>;
}

export function createPreviewController(
  onError: (error: unknown) => void,
  onFocusFallback?: () => void,
): PreviewController {
  const dialog = createConfirmDialog(onFocusFallback);
  document.body.append(dialog.element);
  let files: readonly FileView[] = [];
  let onConfirm: (pending: PendingPreview) => void = () => {};
  let renewing = false;

  const showPending = (): void => {
    const pending = pendingPreview();
    if (!pending) {
      // Nothing pending: just make sure the modal is gone. `hide` would also
      // fire the cancel handler, so close the element directly instead.
      if (dialog.element.open) dialog.element.close();
      return;
    }
    const forced = pending.kind === "branch" && pending.branch.force;
    const copy = forced ? branchForceCopy : previewCopy[pending.kind];
    // A restore is the one ticket that is not asked about one set of paths, so it
    // is the one shown as sections; every other kind shows the list Git named.
    const names: ConfirmNames =
      pending.kind === "restore"
        ? restoreReading(pending.restore.preview)
        : { candidates: pending.names, targetOid: targetOidOf(pending) };
    dialog.show({ kind: pending.kind, dropped: pending.dropped, names, ...copy });
  };

  dialog.onConfirm(() => {
    const pending = pendingPreview();
    setPendingPreview(null);
    if (pending) onConfirm(pending);
  });
  dialog.onCancel((reason) => {
    setPendingPreview(null);
    // "user" means the user dismissed it (button or Escape) and deserves a
    // plain confirmation; anything else is a programmatic close that already
    // carries its own text, or one that should stay silent.
    if (reason === "user") setStatus("Cancelled; nothing was changed.");
    else if (reason !== "") setStatus(reason);
  });

  const request = async (
    kind: PreviewKindKey,
    args: Record<string, unknown>,
    currentFiles: readonly FileView[] | null,
  ): Promise<void> => {
    // The one refusal that can actually be reached from outside the dialog: a
    // row's `⋯` menu is built when it opens and stays open through a write the
    // user started elsewhere, so its items outlive the state that made them
    // inert. A click that asks nothing must not look like a click that did
    // nothing.
    if (isWriteRunning()) {
      setStatus(`A write is still running; this ${labelFor(kind)} was not asked.`);
      return;
    }
    // Both remaining guards are unreachable while the panel is on screen — the
    // modal dialog makes the page behind it inert, and no repository means no
    // changes area to click in — so they stay silent rather than invent words
    // for a state the user cannot be in.
    if (!currentSnapshot() || pendingPreview()) return;
    const snapshot = currentSnapshot();
    if (snapshot === null) return;
    setStatus(`Checking what this ${labelFor(kind)} would change…`);
    try {
      // A restore is the one kind that does not answer with a candidate list: it
      // returns the classes of path its ticket binds. It is also the one renewed by
      // the text that was typed rather than by the names it showed, because those
      // names are six lists at once and none of them is a file the user clicked.
      if (kind === "restore") {
        const preview = await invoke<RestorePreviewResult>(commandFor(kind), {
          snapshotVersion: snapshot.version,
          target: args.target,
        });
        applySnapshot(preview.snapshot);
        setPendingPreview({
          kind: "restore",
          dropped: [],
          nonce: preview.nonce,
          restore: { target: String(args.target), preview },
        });
        showPending();
        return;
      }
      const preview = await invoke<PreviewResult>(commandFor(kind), { snapshotVersion: snapshot.version, ...args });
      applySnapshot(preview.snapshot);
      files = currentFiles ?? [];
      setPendingPreview(build(kind, preview, args));
      showPending();
    } catch (error) {
      onError(error);
      setStatus(`The ${labelFor(kind)} was refused before anything changed.`);
    }
  };

  // A ticket that was asked about files is renewed against the new snapshot by
  // its names, because the ids it was built from died with the snapshot that
  // produced them. `idsForNames` is the rule that fails that renewal rather than
  // carry a partial list across; see `fileModel.ts` for why.
  const renew = async (): Promise<void> => {
    const pending = pendingPreview();
    if (pending === null || renewing || currentSnapshot() === null) return;
    const snapshot = currentSnapshot();
    if (snapshot === null) return;
    renewing = true;
    try {
      let args: Record<string, unknown> = requestArgs(pending);
      if (pending.kind === "discard") {
        const ids = idsForNames(files, pending.names, discardEligible);
        if (ids === null) {
          close("The changed files moved after the preview; ask again to confirm.");
          return;
        }
        args = { fileIds: ids };
      }
      if (pending.kind === "clean") {
        // The whole-repository promise restates itself as no file ids: its names
        // can include a collapsed directory that no row points at, so they cannot
        // be turned back into ids the way one selected path's can.
        const ids = pending.allUntracked ? [] : idsForNames(files, pending.names, cleanEligible);
        if (ids === null) {
          close("The untracked files moved after the preview; ask again to confirm.");
          return;
        }
        args = { fileIds: ids };
      }
      if (pending.kind === "restore") {
        // The renewal hands Git the text that was typed again, because that is all
        // the ticket has: the six lists it showed are display names of paths, and a
        // target that no longer names exactly one commit is refused below rather
        // than carried over as the commit it named last time.
        const preview = await invoke<RestorePreviewResult>(commandFor(pending.kind), {
          snapshotVersion: snapshot.version,
          ...args,
        });
        applySnapshot(preview.snapshot);
        setPendingPreview({
          kind: "restore",
          dropped: [],
          nonce: preview.nonce,
          restore: { target: pending.restore.target, preview },
        });
        showPending();
        setStatus("The status changed; the preview was recomputed.");
        return;
      }
      const preview = await invoke<PreviewResult>(commandFor(pending.kind), {
        snapshotVersion: snapshot.version,
        ...args,
      });
      applySnapshot(preview.snapshot);
      setPendingPreview(rebuild(pending, preview));
      showPending();
      setStatus("The status changed; the preview was recomputed.");
    } catch (error) {
      close();
      onError(error);
      setStatus("The preview is no longer valid.");
    } finally {
      renewing = false;
    }
  };

  const close = (message?: string): void => {
    setPendingPreview(null);
    dialog.hide(message);
  };

  return {
    dialog,
    request,
    close,
    renew,
    onConfirm(handler) { onConfirm = handler; },
  };
}

function labelFor(kind: PreviewKindKey): string {
  switch (kind) {
    case "discard": return "discard";
    case "clean": return "clean";
    case "branch": return "branch deletion";
    case "tag": return "tag deletion";
    case "stashDrop": return "stash deletion";
    case "stashPop": return "stash pop";
    case "restore": return "clean restore";
    case "worktreeRemove": return "worktree removal";
  }
}

function commandFor(kind: PreviewKindKey): string {
  switch (kind) {
    case "discard": return "preview_discard";
    case "clean": return "preview_clean";
    case "branch": return "preview_delete_branch";
    case "tag": return "preview_delete_tag";
    case "stashDrop": return "preview_stash_drop";
    case "stashPop": return "preview_stash_pop";
    case "restore": return "preview_restore";
    case "worktreeRemove": return "preview_remove_worktree";
  }
}

function requestArgs(pending: PendingPreview): Record<string, unknown> {
  switch (pending.kind) {
    case "branch": return { name: pending.branch.name, force: pending.branch.force };
    case "tag": return { name: pending.tag.name };
    case "stashDrop":
    case "stashPop": return { index: pending.stash.index };
    case "restore": return { target: pending.restore.target };
    case "worktreeRemove": return { index: pending.worktree.index };
    case "discard":
    case "clean": return {};
  }
}

function targetOidOf(pending: PendingPreview): string | null {
  switch (pending.kind) {
    case "branch": return pending.branch.targetOid;
    case "tag": return pending.tag.targetOid;
    case "stashDrop":
    case "stashPop": return pending.stash.targetOid;
    case "worktreeRemove": return pending.worktree.targetOid;
    default: return null;
  }
}

// A restore is built and renewed outside these two: its preview is not a
// `PreviewResult`, and the ticket carries it whole rather than a candidate list.
type FlatPreviewKind = Exclude<PreviewKindKey, "restore">;
type FlatTicket = Exclude<PendingPreview, { kind: "restore" }>;

function build(kind: FlatPreviewKind, preview: PreviewResult, args: Record<string, unknown>): PendingPreview {
  const base = { names: preview.candidates, dropped: preview.dropped, nonce: preview.nonce };
  switch (kind) {
    case "discard": return { kind, ...base };
    case "clean":
      return { kind, ...base, allUntracked: !Array.isArray(args.fileIds) || args.fileIds.length === 0 };
    case "branch":
      return { kind, ...base, branch: { name: String(args.name), force: Boolean(args.force), targetOid: preview.targetOid } };
    case "tag": return { kind, ...base, tag: { name: String(args.name), targetOid: preview.targetOid } };
    case "stashDrop": return { kind, ...base, stash: { index: Number(args.index), targetOid: preview.targetOid } };
    case "stashPop": return { kind, ...base, stash: { index: Number(args.index), targetOid: preview.targetOid } };
    case "worktreeRemove": return { kind, ...base, worktree: { index: Number(args.index), targetOid: preview.targetOid } };
  }
}

// A renew keeps the identity of the open ticket (its kind and its per-kind
// payload) and swaps only what the fresh preview computed. The fields are
// listed one arm at a time rather than spread from `pending`, so the
// discriminant of the returned ticket is provably the matched arm.
function rebuild(pending: FlatTicket, preview: PreviewResult): PendingPreview {
  const names = preview.candidates;
  const dropped = preview.dropped;
  const nonce = preview.nonce;
  const oid = preview.targetOid;
  switch (pending.kind) {
    case "discard": return { kind: "discard", names, dropped, nonce };
    case "clean": return { kind: "clean", names, dropped, nonce, allUntracked: pending.allUntracked };
    case "branch": return { kind: "branch", names, dropped, nonce, branch: { ...pending.branch, targetOid: oid } };
    case "tag": return { kind: "tag", names, dropped, nonce, tag: { ...pending.tag, targetOid: oid } };
    case "stashDrop":
    case "stashPop": return { kind: pending.kind, names, dropped, nonce, stash: { ...pending.stash, targetOid: oid } };
    case "worktreeRemove": return { kind: "worktreeRemove", names, dropped, nonce, worktree: { ...pending.worktree, targetOid: oid } };
  }
}
