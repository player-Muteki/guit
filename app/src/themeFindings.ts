// What a refused theme fragment says to the person who pasted it.
//
// The review decides; this only reports, and it is separate because the report has
// its own failures to prevent: a fragment of two hundred bad rules must not fill the
// Settings page with two hundred lines, and a reason the app has no words for must
// not render as an empty row or as "unknown". Both are user-facing text, so both are
// decided here rather than in the view that draws it.

import type { ThemeFinding } from "./themeCssModel";

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
