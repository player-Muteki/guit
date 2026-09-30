// How a restore preview is read out: one heading about the commit it moves to,
// and one section per class of path the two steps touch.
//
// The backend computed these sets and bound them into the ticket; what it hands
// over is six lists plus the two ids Git resolved. This module is the only place
// that decides what each list is *called*, because the classes differ in the verb
// they deserve: the target's version *changes* one path, the restore *writes over*
// an untracked one, the second step *deletes* another, and a nested repository
// simply *stays*. Drawing them as one flat name list would make four different
// promises look like the same promise, which is the thing the preview exists to
// prevent.
//
// Two rules hold the grouping honest. A class with nothing in it contributes no
// section at all — an empty list is a fact about this repository, not a heading to
// read through. And a path is named exactly as Git named it, because the dialog
// shows the preview verbatim: nothing here sorts, truncates or merges a name.

import type { RestorePreviewResult } from "./types";

export interface RestoreSection {
  label: string;
  items: string[];
}

export interface RestoreReading {
  /** Where HEAD is and where the restore puts it, as Git resolved both. */
  heading: string;
  sections: RestoreSection[];
}

// The order is the order of what happens: what the first step writes, then what
// the second step removes, then what neither touches.
type RestoreListKey =
  | "changed"
  | "discarded"
  | "overwritten"
  | "ignoredWritten"
  | "removed"
  | "leftBehind";

const SECTION_ORDER: Array<{ key: RestoreListKey; label: string }> = [
  { key: "changed", label: "Tracked paths the target's version changes" },
  { key: "discarded", label: "Local changes this throws away" },
  { key: "overwritten", label: "Untracked paths the restore writes over" },
  { key: "ignoredWritten", label: "Ignored paths the target holds anyway" },
  { key: "removed", label: "Untracked paths deleted after the restore" },
  { key: "leftBehind", label: "Untracked paths that stay — guit does not enter another repository" },
];

/** An id as the panel shows one: ten characters, the way every other id is read out. */
export function shortId(oid: string): string {
  return oid.slice(0, 10);
}

export function restoreReading(preview: RestorePreviewResult): RestoreReading {
  const sections: RestoreSection[] = [];
  for (const { key, label } of SECTION_ORDER) {
    const items = preview[key];
    if (items.length === 0) continue;
    sections.push({ label: `${label} (${items.length})`, items });
  }
  return {
    heading: `HEAD moves from ${shortId(preview.headOid)} to ${shortId(preview.targetOid)}`,
    sections,
  };
}
