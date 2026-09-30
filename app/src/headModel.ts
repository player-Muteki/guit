// Pure view-model for what HEAD is called, and which names may be handed to Git.
//
// Two places answer "whose history is this" — the app bar's chip and the commit
// graph's own header — and a state described twice is a state described two
// ways unless one rule describes it. Both draw from here, so detached and
// unborn are named rather than guessed at from a missing field: the backend
// already keeps the three apart (`BranchView.name` and `.oid` are both optional,
// and `headState` says which of the three cases the panel is in), so nothing
// here has to invent a sentinel to tell "no commits yet" from "no name".
//
// The second half of this module decides what a switch can be asked *for*. That
// rule is not a UI preference: a name whose bytes did not survive the round trip
// to a string cannot be turned back into a Git argument, and a remote-tracking
// name is not a branch at all — Git refuses it rather than detaching, so the
// panel refuses it first and says why in the same words it uses anywhere else.

import type { BranchRef, BranchView } from "./types";

// The three states, in one wording. A branch with no commits and a HEAD with no
// name are the two cases an empty string would describe as "nothing at all".
export function branchLabel(branch: BranchView | null): string {
  if (!branch) return "bare repository";
  if (branch.headState === "detached") return `detached at ${branch.oid?.slice(0, 8) ?? "?"}`;
  if (branch.headState === "unborn") return `${branch.name ?? "?"} (no commits yet)`;
  return branch.name ?? "?";
}

/** The counts, only when there is an upstream to count against. */
export function aheadBehind(
  ref: { upstream: string | null; ahead: number | null; behind: number | null } | null,
): string {
  if (!ref || !ref.upstream) return "";
  const parts: string[] = [];
  if (ref.ahead !== null) parts.push(`↑${ref.ahead}`);
  if (ref.behind !== null) parts.push(`↓${ref.behind}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/** What one branch of the listing is worth saying: where it tracks, whether that
 * tracking ref is gone, and how far apart they are. */
export function branchDetail(ref: BranchRef): string {
  const parts: string[] = [];
  if (ref.upstream) parts.push(`→ ${ref.upstream}`);
  if (ref.upstreamGone) parts.push("upstream gone");
  if (ref.ahead !== null) parts.push(`↑${ref.ahead}`);
  if (ref.behind !== null) parts.push(`↓${ref.behind}`);
  return parts.join("  ");
}

export type BranchChoice = {
  name: string;
  detail: string;
  /** The row HEAD is on: shown, so the list is the repository's own list, and
   * not a target, because switching to it is a Git run that changes nothing. */
  current: boolean;
  /** Whether this name can be handed to Git at all. */
  runnable: boolean;
  /** Why it cannot, when it cannot — never a silent absence. */
  reason: string | null;
};

const NOT_A_NAME = "This branch name is not byte-round-trippable; it cannot be switched to.";

/**
 * The local branches a switch may be asked for, in the order Git listed them.
 *
 * `current` is decided from both signals and their union, because the two arrive
 * on different counters: the listing answers the references generation and the
 * head comes from the snapshot. A switch moves both, so between a write and the
 * names read after it they can disagree — and a row that either side calls the
 * checked-out one is a row this panel will not switch to.
 */
export function branchChoices(branches: readonly BranchRef[], head: BranchView | null): BranchChoice[] {
  const named = head !== null && head.headState !== "detached" ? head.name : null;
  return branches.map((ref) => {
    const current = ref.head || ref.name === named;
    const runnable = !current && ref.addressable;
    return {
      name: ref.name,
      detail: branchDetail(ref),
      current,
      runnable,
      reason: runnable || current ? null : NOT_A_NAME,
    };
  });
}
