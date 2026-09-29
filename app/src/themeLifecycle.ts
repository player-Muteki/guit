// The custom theme's life cycle: what may be drawn, what counts as having worked,
// and what happens when it did not.
//
// This is a pure module on purpose. The questions it answers are the ones that must
// not depend on a renderer that may itself be the thing that is broken:
//
// - A fragment that takes the window down never reports back. Absence of a report is
//   therefore evidence of failure, and the only way to act on it is to remember the
//   intent *before* drawing and read it at the next launch. That is what `unverified`
//   is for, and it is why it lives in the stored record rather than in a variable.
// - Getting the built-in look back must never depend on the fragment. Every entry
//   point that restores safety here reads the record's flags, not the text.
// - "It drew something" is not "it worked": a fragment that hides the control which
//   turns it off has failed the one job the panel has to keep.
//
// The DOM side supplies the outcomes (`verified`, `hid-recovery`) and performs the
// effects; it never decides them.

/** What is stored about the custom theme. `null` for `unverified` means "nothing is
 * in flight", which is the normal state. */
export interface ThemeRecord {
  /** The text the person wrote, stored as written — including while it is failing,
   * because losing their text is its own bug. */
  draft: string;
  /** Whether a custom fragment may be drawn at all. Auto-disabled by a failed
   * verification and by a fragment that never reported back; turned back on only by
   * the person. */
  enabled: boolean;
  /** Text that has been asked of the renderer but not confirmed. Read at launch: a
   * leftover here means the session that drew it ended before it could say whether
   * the panel was still usable. */
  unverified: string | null;
}

/** What the caller must do to the screen. `css: ""` is not a valid thing to draw:
 * clearing is its own effect so no caller can apply an empty stylesheet and call the
 * result the built-in look. */
export type ThemeEffect = { kind: "draw"; css: string } | { kind: "clear" } | { kind: "keep" };

/** Why the screen changed, as a code the settings page puts into words. Kept as a
 * code so the wording lives with the other shipped text instead of here. */
export type ThemeNotice =
  | "confirmed"
  | "reverted"
  | "hidden-controls"
  | "disabled"
  | "unconfirmed"
  | null;

export interface ThemeDecision {
  record: ThemeRecord;
  effect: ThemeEffect;
  notice: ThemeNotice;
}

/** The look guit draws when no fragment is in play. */
export const BUILT_IN = "";

export function themeRecord(draft: string, enabled: boolean): ThemeRecord {
  return { draft, enabled, unverified: null };
}

/** The decision made before any drawing, from what storage said.
 *
 * `safe` is the person's own "start without custom themes", which may come from a
 * launch flag or from the recovery entry in the window; it outranks the record and
 * leaves the record untouched, so the next ordinary start behaves as it was set to.
 *
 * When this returns a draw, the caller owes the same write it owes for any other
 * draw: store the record, and only draw if storage took it. A fragment drawn on a
 * restart whose marker never landed is a fragment that can crash the window twice
 * and report itself as having worked once.
 */
export function launchTheme(record: ThemeRecord, safe: boolean): ThemeDecision {
  if (record.unverified !== null) {
    // Last session drew a fragment and never confirmed it. Clear the marker first:
    // a record that still carries it after this decision would report the same
    // failure again on the next start, and a person who fixed nothing would see
    // nothing.
    const cleared: ThemeRecord = { ...record, unverified: null, enabled: false };
    return { record: cleared, effect: { kind: "clear" }, notice: "unconfirmed" };
  }
  if (safe || !record.enabled || record.draft === BUILT_IN) {
    return { record, effect: { kind: "clear" }, notice: safe ? "disabled" : null };
  }
  return {
    record: { ...record, unverified: record.draft },
    effect: { kind: "draw", css: record.draft },
    // Nothing to say: the person's own saved theme loaded. A notice is for the
    // times the panel had to decide something on their behalf.
    notice: null,
  };
}

/** Ask the renderer for a fragment. Everything the caller knows about what was on
 * screen before is passed in as `previous`, because the revert has to restore
 * exactly that and not a guess.
 *
 * This is also how a theme that was switched off comes back: the page applies the text
 * its own box holds, and a box prefilled from the record makes that one press. There is
 * deliberately no second entry that re-enables a stored draft without naming its text —
 * a hostile fragment should need the person to look at it again, not a shortcut. */
export function beginApply(record: ThemeRecord, draft: string): ThemeDecision {
  if (draft === BUILT_IN) {
    return stopTheme({ ...record, draft });
  }
  return {
    record: { draft, enabled: true, unverified: draft },
    effect: { kind: "draw", css: draft },
    notice: null,
  };
}

/** The outcome of looking at the drawn panel.
 *
 * `verified` — drew, and the controls are still reachable.
 * `refused` — the renderer said it would not take the text.
 * `hid-recovery` — it drew and took away the way back.
 */
export type ThemeOutcome = "verified" | "refused" | "hid-recovery";

export function finishApply(
  record: ThemeRecord,
  outcome: ThemeOutcome,
  previous: string,
): ThemeDecision {
  if (outcome === "verified") {
    return {
      record: { ...record, unverified: null },
      effect: { kind: "keep" },
      notice: "confirmed",
    };
  }
  const reverted: ThemeRecord = { ...record, enabled: false, unverified: null };
  if (outcome === "hid-recovery") {
    // The text stays as the person wrote it so they can remove the rule; the
    // fragment is off, and the look that was reachable before is drawn again.
    return {
      record: reverted,
      effect: previous === BUILT_IN ? { kind: "clear" } : { kind: "draw", css: previous },
      notice: "hidden-controls",
    };
  }
  return {
    record: reverted,
    effect: previous === BUILT_IN ? { kind: "clear" } : { kind: "draw", css: previous },
    notice: "reverted",
  };
}

/** The person's own "use no custom theme". The only entry point that guarantees the
 * built-in look without reading the fragment at all. */
export function stopTheme(record: ThemeRecord): ThemeDecision {
  return {
    record: { ...record, enabled: false, unverified: null },
    effect: { kind: "clear" },
    notice: "disabled",
  };
}
