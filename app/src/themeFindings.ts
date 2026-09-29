// What a theme has to say to the person who chose it: the rules a fragment lost, and
// the reason the screen changed under them.
//
// The review decides and the life cycle decides; this only reports, and it is separate
// because the report has its own failures to prevent: a fragment of two hundred bad
// rules must not fill the Settings page with two hundred lines, a reason the app has no
// words for must not render as an empty row or as "unknown", and the sentence that
// tells someone how to escape a theme must not be a copy that drifted from the keys
// that actually escape. So the shortcut is named here, once, and a test holds the key
// binding in the window's listener to this string rather than the other way round.
//
// Pure: no DOM, no stylesheet, no storage.

import type { ThemeFinding } from "./themeCssModel";
import type { ThemeNotice } from "./themeLifecycle";

/** One sentence per reason the reviewer can give, in the panel's own voice: what was
 * refused, and what the fragment loses by it. `never` is not one of these values, so
 * a reason added to the review has to be given words here before the build passes. */
const REASONS: Record<ThemeFinding["because"], string> = {
  network: "names something outside the panel, which guit never loads",
  layout: "moves what the panel measures its rows by",
  "hides-controls": "would take a control you need to get back here",
  "overrides-panel": "insists on beating a colour the panel chose to stay readable",
  "too-wide": "can set more than it says, so write the specific property instead",
  "not-a-theme": "is neither a colour nor a typeface",
  "not-readable": "is not a value the panel's renderer could read, so nothing from it is applied",
};

/** Two findings are about a whole rule rather than about one name inside it, and
 * no reason string says what they mean: the rule was not misbehaving, it simply
 * ended up with nothing to keep, or the text was never read as rules at all. */
const RULE_STATEMENTS: Partial<Record<ThemeFinding["kind"], string>> = {
  empty: "nothing in it is a colour or a typeface, so nothing was kept",
  unparsed: "could not be read as a stylesheet, so none of it was kept",
};

/** How many lines the fragment report shows before it says how many more there are.
 * A cap is a product choice, not a safety one: the refused text is already not
 * applied, so what a long list costs is the person's attention. */
export const FINDING_LIMIT = 8;

/** One finding, as one line. */
export function describeFinding(finding: ThemeFinding): string {
  const statement = RULE_STATEMENTS[finding.kind];
  if (statement !== undefined) return `${finding.at} — ${statement}`;
  // A top-level rule's path and its own name are the same string; saying it twice
  // reads like two different things were refused there.
  const subject =
    finding.item === "" || finding.item === finding.at ? finding.at : `${finding.at}: ${finding.item}`;
  return `${subject} — ${REASONS[finding.because]}`;
}

export interface FindingReport {
  rows: string[];
  /** Lines the report holds back because of the cap. */
  omitted: number;
}

/** The rows the settings page shows, in the order the fragment failed, with repeats
 * of the same statement counted once. */
export function describeFindings(
  findings: ThemeFinding[],
  limit: number = FINDING_LIMIT,
): FindingReport {
  const unique: string[] = [];
  for (const finding of findings) {
    const row = describeFinding(finding);
    if (!unique.includes(row)) unique.push(row);
  }
  return { rows: unique.slice(0, limit), omitted: Math.max(0, unique.length - limit) };
}

/** The keys that turn a custom theme off from anywhere in the window. They are stated
 * in the text layer because the sentences below have to name them, and a shortcut that
 * reads differently in the row and in the warning is two shortcuts. The binding itself
 * is a `keydown` branch in `main.ts`, which runs the same action as the page's button; a
 * test holds the two to the same keys. */
export const THEME_RECOVERY_KEYS = "Ctrl/Cmd + Shift + T";

/** One sentence per way a theme's screen can change. `null` is a change with nothing
 * to say — the person's own saved theme loaded, or nothing happened — and is reported
 * as no text at all rather than as a reassurance nobody asked for.
 *
 * The last three are the times the panel decided something on the person's behalf, so
 * each says what was decided *and* what they can do about it: the key press is the one
 * action that works whatever the theme currently on screen did to the page. */
const NOTICES: Record<Exclude<ThemeNotice, null>, string> = {
  confirmed: "Applied, and the way back out is still on the screen.",
  reverted: "Nothing in it could be drawn, so the look from before is back and the custom theme is off.",
  "hidden-controls": `It drew, but it hid the controls that turn it off, so it is off. ${THEME_RECOVERY_KEYS} does this from anywhere.`,
  disabled: "The custom theme is off, and the built-in look is back.",
  unconfirmed:
    "A theme from the last session never reported that it worked, so it was not drawn. Its text is still in the box.",
};

export function describeThemeNotice(notice: ThemeNotice): string | null {
  if (notice === null) return null;
  return NOTICES[notice];
}

/** Everything a report has to say in prose, in the order the person needs it: why the
 * screen is what it is, how much of the text was refused beyond the lines shown, and
 * whether the next start will behave the same way. */
export function describeTheme(report: { notice: ThemeNotice; persisted: boolean; findings: FindingReport }): string {
  const sentences: string[] = [];
  const notice = describeThemeNotice(report.notice);
  if (notice !== null) sentences.push(notice);
  const omitted = report.findings.omitted;
  if (omitted > 0) {
    sentences.push(`${omitted} more ${omitted === 1 ? "rule was" : "rules were"} refused than these lines show.`);
  }
  if (!report.persisted) sentences.push("guit could not save this, so the next start will not do it.");
  return sentences.join(" ");
}
