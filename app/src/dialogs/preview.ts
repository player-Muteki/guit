// The single-use ticket flow shared by every destructive action
// preview → recheck → confirm.
//
// One controller owns the pending ticket, the modal dialog and the renew
// hook. A newer snapshot invalidates file IDs, so while a ticket is open
// every accepted snapshot re-requests the preview against fresh Git state;
// a changed candidate set is surfaced verbatim and the user must confirm
// again. The confirm event carries the ticket's `kind` and `nonce`; the
// owning view maps the kind to its backend command and only ever sends
// `{ nonce }`.

import { invoke } from "@tauri-apps/api/core";
import {
  applySnapshot,
  currentSnapshot,
  isWriteRunning,
  pendingPreview,
  setPendingPreview,
  setStatus,
  type PendingPreview,
} from "../state";
import type { FileView, PreviewCopy, PreviewKindKey, PreviewResult } from "../types";
import { createConfirmDialog, type ConfirmDialog } from "./confirm";

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
  resetHard: {
    warning:
      "Hard reset overwrites the listed working-copy changes with the selected commit's contents and moves the branch back. Staged-only files may be deleted from disk, and the commits left behind become unreachable; Git may garbage-collect them. This cannot be undone from guit.",
    confirm: "Reset hard",
    cancel: "Keep everything",
    droppedLabel: "Commits left behind",
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

function discardEligible(file: FileView): boolean {
  return file.unstaged && !file.conflict && !file.untracked;
}

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
    dialog.show({
      kind: pending.kind,
      candidates: pending.names,
      dropped: pending.dropped,
      targetOid: targetOidOf(pending),
      ...copy,
    });
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
    if (!currentSnapshot() || isWriteRunning() || pendingPreview()) return;
    const snapshot = currentSnapshot();
    if (snapshot === null) return;
    setStatus(`Checking what this ${labelFor(kind)} would change…`);
    try {
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

  const renew = async (): Promise<void> => {
    const pending = pendingPreview();
    if (pending === null || renewing || currentSnapshot() === null) return;
    const snapshot = currentSnapshot();
    if (snapshot === null) return;
    renewing = true;
    try {
      let args: Record<string, unknown> = requestArgs(pending);
      if (pending.kind === "discard") {
        const ids: number[] = [];
        for (const name of pending.names) {
          const matches = files.filter((file) => file.display === name && discardEligible(file));
          if (matches.length !== 1) {
            close("The changed files moved after the preview; ask again to confirm.");
            return;
          }
          ids.push(matches[0].id);
        }
        args = { fileIds: ids };
      }
      if (pending.kind === "clean") args = {};
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
    case "resetHard": return "hard reset";
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
    case "resetHard": return "preview_reset_hard";
    case "worktreeRemove": return "preview_remove_worktree";
  }
}

function requestArgs(pending: PendingPreview): Record<string, unknown> {
  switch (pending.kind) {
    case "branch": return { name: pending.branch.name, force: pending.branch.force };
    case "tag": return { name: pending.tag.name };
    case "stashDrop":
    case "stashPop": return { index: pending.stash.index };
    case "resetHard": return { target: pending.reset.target };
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

function build(kind: PreviewKindKey, preview: PreviewResult, args: Record<string, unknown>): PendingPreview {
  const base = { names: preview.candidates, dropped: preview.dropped, nonce: preview.nonce };
  switch (kind) {
    case "discard": return { kind, ...base };
    case "clean": return { kind, ...base };
    case "branch":
      return { kind, ...base, branch: { name: String(args.name), force: Boolean(args.force), targetOid: preview.targetOid } };
    case "tag": return { kind, ...base, tag: { name: String(args.name), targetOid: preview.targetOid } };
    case "stashDrop": return { kind, ...base, stash: { index: Number(args.index), targetOid: preview.targetOid } };
    case "stashPop": return { kind, ...base, stash: { index: Number(args.index), targetOid: preview.targetOid } };
    case "resetHard": return { kind, ...base, reset: { target: String(args.target) } };
    case "worktreeRemove": return { kind, ...base, worktree: { index: Number(args.index), targetOid: preview.targetOid } };
  }
}

// A renew keeps the identity of the open ticket (its kind and its per-kind
// payload) and swaps only what the fresh preview computed. The fields are
// listed one arm at a time rather than spread from `pending`, so the
// discriminant of the returned ticket is provably the matched arm.
function rebuild(pending: PendingPreview, preview: PreviewResult): PendingPreview {
  const names = preview.candidates;
  const dropped = preview.dropped;
  const nonce = preview.nonce;
  const oid = preview.targetOid;
  switch (pending.kind) {
    case "discard": return { kind: "discard", names, dropped, nonce };
    case "clean": return { kind: "clean", names, dropped, nonce };
    case "branch": return { kind: "branch", names, dropped, nonce, branch: { ...pending.branch, targetOid: oid } };
    case "tag": return { kind: "tag", names, dropped, nonce, tag: { ...pending.tag, targetOid: oid } };
    case "stashDrop":
    case "stashPop": return { kind: pending.kind, names, dropped, nonce, stash: { ...pending.stash, targetOid: oid } };
    case "resetHard": return { kind: "resetHard", names, dropped, nonce, reset: { ...pending.reset } };
    case "worktreeRemove": return { kind: "worktreeRemove", names, dropped, nonce, worktree: { ...pending.worktree, targetOid: oid } };
  }
}
