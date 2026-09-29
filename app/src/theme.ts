// The custom theme: the one stylesheet element the panel owns, the three theme fields
// of the stored record, and the way back out when the fragment is the problem.
//
// The decisions are not here. `themeParse.ts` reads what a person wrote,
// `themeCssModel.ts` decides what a fragment may say, `themeCss.ts` hands accepted
// declarations to the renderer, and `themeLifecycle.ts` decides what may be drawn and
// what counts as having worked. What this module adds is the one question none of them
// can ask: whether the way out is still on the screen, right now, in this document.
//
// Two orders are fixed, and most of the rest follows from them.
//
// **Storage first, screen second.** A fragment that takes a window down never reports
// back, so the only evidence the next start can use is a marker written before the
// draw. That makes a draw conditional on its marker coming back from storage: a
// fragment applied on a write nobody took is one that can break the panel twice and
// describe itself as having worked once.
//
// **The recovery entry is a key press on the window, not a control in the page.** A
// listener on `window` exists before any theme has been applied and cannot be styled
// away, hidden, or removed by a fragment, so it is the entry the panel can promise. The
// button on the Settings page is that same action with a label on it, and the
// reachability check below exists to notice when a fragment has taken the *label* away.

import { appearanceRecord, persistTheme } from "./appearanceStore";
import { reviewThemeFragment, writeThemeStyle } from "./themeCss";
import type { ThemeFinding } from "./themeCssModel";
import type { FindingReport } from "./themeFindings";
import { describeFindings } from "./themeFindings";
import { themeRecordOf } from "./preferencesModel";
import { BUILT_IN, beginApply, finishApply, launchTheme, stopTheme } from "./themeLifecycle";
import type { ThemeDecision, ThemeNotice, ThemeRecord } from "./themeLifecycle";

/** What the panel did with a fragment. `notice` says why the screen changed, `applied`
 * is the text the panel will actually hold, and `findings` is what the person's own
 * text was cut down to.
 *
 * `persisted` is kept apart from every refusal of the text because it is a different
 * failure: the theme is running in this window and will not be there next start. */
export interface ThemeReport {
  notice: ThemeNotice;
  applied: string;
  findings: FindingReport;
  persisted: boolean;
}

/** The sentinel that asks for one start without a custom theme. Session storage rather
 * than the record on purpose: it names a single window, and a value that outlived it
 * would leave a later start skipping a theme its own record says to draw. */
const SAFE_START_KEY = "guit.themeSafeStart";

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Read the sentinel and consume it: one start, as asked. */
function safeStartRequested(): boolean {
  const store = sessionStore();
  if (store === null) return false;
  try {
    if (store.getItem(SAFE_START_KEY) === null) return false;
    store.removeItem(SAFE_START_KEY);
    return true;
  } catch {
    return false;
  }
}

function askSafeNextStart(): void {
  try {
    sessionStore()?.setItem(SAFE_START_KEY, "1");
  } catch {
    // A window with no session storage gets the key press now and the record's own
    // answer later. There is nothing else to fall back to and nothing to claim.
  }
}

let host: HTMLStyleElement | null = null;

function styleHost(): HTMLStyleElement {
  if (host !== null) return host;
  const created = document.createElement("style");
  created.id = "guit-theme";
  document.head.append(created);
  host = created;
  return created;
}

/** The engine text on the screen, or `BUILT_IN` for none — kept because a revert has
 * to put back what was there, and a fragment's own text is not it. */
let drawn = BUILT_IN;

/** A draw whose verification has not happened yet. Non-null across the launch window:
 * a boot that never reaches verification leaves the marker in storage, which is exactly
 * the failure that marker exists to record. */
let inFlight: { record: ThemeRecord; findings: ThemeFinding[] } | null = null;

function currentRecord(): ThemeRecord {
  return themeRecordOf(appearanceRecord().prefs);
}

/** Write the fragment into the panel's own element and say what the renderer made of
 * it.
 *
 * The text is reviewed on the way in even when it came out of storage, because a
 * fragment's rules are not a fact about the machine that last applied it: the same text
 * can name a colour this engine will not read, and text applied without being reviewed
 * is a stylesheet no gate has seen.
 *
 * Nothing surviving the review is reported rather than drawn: an empty stylesheet is a
 * clear, and a clear is its own effect. */
function apply(css: string): { drew: boolean; applied: string; findings: ThemeFinding[] } {
  const reviewed = reviewThemeFragment(css);
  if (reviewed.empty) return { drew: false, applied: BUILT_IN, findings: reviewed.findings };
  const text = reviewed.rules.join("\n");
  writeThemeStyle(styleHost(), text);
  drawn = text;
  return { drew: true, applied: text, findings: reviewed.findings };
}

function clearScreen(): void {
  if (host !== null) writeThemeStyle(host, "");
  drawn = BUILT_IN;
}

/** Whether the way back out is still reachable.
 *
 * The review refuses every property that could hide a control, so a fragment reaching
 * this point has usually been cut down already. The check is still made because custom
 * properties are open by design: a fragment may set a name the panel invented for
 * itself, and wherever the sheet uses such a name inside a layout property, hiding
 * something needs no refused declaration at all.
 *
 * Which nodes count is a decision the markup makes, not the caller: the page's own tab
 * buttons and the button that turns a theme off carry `data-recovery`. A node the panel
 * has hidden itself with the `hidden` attribute is passed over — the Settings view is
 * behind a tab — because the alternative is reporting a fragment for the page that is
 * not on screen. What is left has to have a box, which is the one thing a fragment can
 * take from a control that is nominally still there.
 */
function recoveryReachable(): boolean {
  for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-recovery]"))) {
    if (node.closest("[hidden]") !== null) continue;
    if (node.getClientRects().length === 0) return false;
  }
  return true;
}

/** Store the intent, draw it, look at the panel that resulted, and store what that
 * meant. Every entry point below runs this, in this order. */
function attempt(decision: ThemeDecision, previous: string, findings: ThemeFinding[]): ThemeReport {
  if (decision.effect.kind !== "draw") {
    const stored = persistTheme(decision.record);
    if (decision.effect.kind === "clear") clearScreen();
    inFlight = null;
    return { notice: decision.notice, applied: drawn, findings: describeFindings(findings), persisted: stored.persisted };
  }
  const stored = persistTheme(decision.record);
  if (!stored.persisted) {
    // The marker did not arrive, so neither this window nor the next start could tell
    // this fragment from a dead one. Nothing is drawn and nothing is claimed.
    return { notice: decision.notice, applied: drawn, findings: describeFindings(findings), persisted: false };
  }
  const wrote = apply(decision.effect.css);
  const outcome = !wrote.drew ? "refused" : recoveryReachable() ? "verified" : "hid-recovery";
  if (outcome === "hid-recovery") {
    // The key press still works; the next start is asked to skip the theme as well, so
    // a person who closes the window in a panic does not reopen it into the same wall.
    askSafeNextStart();
  }
  const done = finishApply(decision.record, outcome, previous);
  const kept = persistTheme(done.record);
  if (done.effect.kind === "clear") clearScreen();
  else if (done.effect.kind === "draw") apply(done.effect.css);
  inFlight = null;
  return {
    notice: done.notice,
    applied: outcome === "verified" ? wrote.applied : drawn,
    findings: describeFindings([...findings, ...wrote.findings]),
    persisted: kept.persisted,
  };
}

/** Draw the stored theme, once, before the first paint of the shell, so a person with a working
 * fragment never watches the built-in look flash past it. The report is what the start
 * decided on the person's behalf, and `null` is a start that has nothing to say.
 *
 * The draw is left unverified on purpose: verification needs laid-out nodes, and the
 * first of those only exist once the shell is on the screen. `verifyThemeLaunch` is the
 * other half, and a start that dies before reaching it leaves the marker behind and
 * comes back with no theme — the safer of the two mistakes.
 */
export function startTheme(): ThemeReport | null {
  const decision = launchTheme(currentRecord(), safeStartRequested());
  if (decision.effect.kind !== "draw") {
    const stored = persistTheme(decision.record);
    if (decision.effect.kind === "clear") clearScreen();
    // A record that keeps its own theme off is quiet; a start that had to decide on the
    // person's behalf — one that asked for no themes, or one that found a fragment that
    // never reported back — says so.
    return decision.notice === null
      ? null
      : { notice: decision.notice, applied: BUILT_IN, findings: describeFindings([]), persisted: stored.persisted };
  }
  const stored = persistTheme(decision.record);
  if (!stored.persisted) {
    clearScreen();
    return { notice: null, applied: BUILT_IN, findings: describeFindings([]), persisted: false };
  }
  const wrote = apply(decision.effect.css);
  if (!wrote.drew) {
    const done = finishApply(decision.record, "refused", BUILT_IN);
    const kept = persistTheme(done.record);
    clearScreen();
    return { notice: done.notice, applied: BUILT_IN, findings: describeFindings(wrote.findings), persisted: kept.persisted };
  }
  inFlight = { record: decision.record, findings: wrote.findings };
  return null;
}

/** The other half of `startTheme`, called once the shell is on screen: a fragment that
 * took the way out with it goes back off, and this start says so. */
export function verifyThemeLaunch(): ThemeReport | null {
  const held = inFlight;
  inFlight = null;
  if (held === null) return null;
  if (recoveryReachable()) {
    const done = finishApply(held.record, "verified", BUILT_IN);
    const stored = persistTheme(done.record);
    return {
      notice: null,
      applied: drawn,
      findings: describeFindings(held.findings),
      persisted: stored.persisted,
    };
  }
  askSafeNextStart();
  const done = finishApply(held.record, "hid-recovery", BUILT_IN);
  const stored = persistTheme(done.record);
  if (done.effect.kind === "clear") clearScreen();
  else if (done.effect.kind === "draw") apply(done.effect.css);
  return {
    notice: done.notice,
    applied: drawn,
    findings: describeFindings(held.findings),
    persisted: stored.persisted,
  };
}

/** What the panel would draw for this text, and everything it would refuse first. No
 * screen is touched: this is the review a person reads before applying, and it runs the
 * same `reviewThemeFragment` the apply path does, so what is previewed is what would be
 * held. */
export function previewThemeFragment(css: string): { applied: string; findings: FindingReport } {
  const reviewed = reviewThemeFragment(css);
  return {
    applied: reviewed.empty ? BUILT_IN : reviewed.rules.join("\n"),
    findings: describeFindings(reviewed.findings),
  };
}

/** Apply pasted text: draw it, then look at the panel it produced.
 *
 * Text the review cuts down to nothing is refused whole, without a draw. The lifecycle
 * would read an empty fragment as a theme turned off — which is what it is — but here
 * there is another fragment on the screen, and losing the colours a person can see
 * because new text was unreadable is not what they asked for.
 */
export function applyThemeFragment(css: string): ThemeReport {
  const record = currentRecord();
  const review = previewThemeFragment(css);
  if (css !== BUILT_IN && review.applied === BUILT_IN) {
    // Nothing was asked of storage here, so nothing can have failed there: `persisted`
    // reports on the panel's own writes, not on the last write this session made.
    return { notice: null, applied: drawn, findings: review.findings, persisted: true };
  }
  // The revert restores what was on the screen, which is the panel's drawn text and
  // not the record's draft: the two differ whenever a fragment was cut down on the way
  // in, and re-drawing the person's raw text is not putting the old look back.
  return attempt(beginApply(record, css), drawn, []);
}

/** The built-in look, kept until the person asks for something else. This is what the
 * recovery key press runs and what the page's button runs; the two are the same action,
 * and the record's `enabled` flag is what carries it to the next start. A window whose
 * storage refused the write gets the one-start sentinel on top, because the only
 * promise left worth keeping is that the next start is safe. */
export function disableTheme(): ThemeReport {
  const decision = stopTheme(currentRecord());
  const stored = persistTheme(decision.record);
  clearScreen();
  inFlight = null;
  if (!stored.persisted) askSafeNextStart();
  return {
    notice: decision.notice,
    applied: BUILT_IN,
    findings: describeFindings([]),
    persisted: stored.persisted,
  };
}

/** The three theme fields as the record holds them — the names to draw a row from, as
 * opposed to `drawn`, which is what the panel is actually painting with. */
export function currentThemeFragment(): { draft: string; enabled: boolean; unverified: boolean } {
  const record = currentRecord();
  return { draft: record.draft, enabled: record.enabled, unverified: record.unverified !== null };
}
