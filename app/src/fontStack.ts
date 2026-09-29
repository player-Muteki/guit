// The font stack the panel writes, from the families the user named.
//
// The panel offers three family choices. What it must not offer is a way to change
// what the panel measures: the rows, the columns and the graph are laid out
// in `rem`, and the glyph advance widths that make an OID readable in the history
// list come from a stack whose tail is authored, not typed in. So the named
// families are put in front of a fixed tail.
//
// The tail is a request, not a guarantee, and that was measured: a name the host
// does not have does not step aside for the next entry in the list. The renderer's
// font configuration substitutes some face for it and stops there, so the generic
// keyword at the end is never consulted — and the face it substituted for the
// panel's own default mono stack was proportional. `fontResolve.ts` asks the engine
// whether the stack it is about to write lines an object ID up, and writes the
// generic keyword when it does not. What a missing or half-covering family costs is
// therefore decided by the drawing, not by this list; within one family the engine
// does fall back per character, which is why mixed Chinese-and-Latin text still
// resolves from the pair.
//
// Pure: no DOM, no storage, no stylesheet object. The caller writes the two custom
// properties this feeds and re-measures afterwards.

/** Exactly the value `--font-ui` states in the stylesheet. A test reads the
 * stylesheet to keep it that way, because a default stack that differs between the
 * two is a panel that changes appearance when a family is cleared. */
export const UI_TAIL =
  'system-ui, -apple-system, "Segoe UI", "Noto Sans", "Helvetica Neue", Arial, sans-serif';

/** Exactly the value `--font-mono` states in the stylesheet. The unquoted
 * `monospace` at the end is the only entry here the engine has to honour: quoted, it
 * would be a family called monospace rather than the generic keyword, and a family
 * nobody has gets substituted. Nothing in front of it is promised anything. */
export const MONO_TAIL =
  'ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace';

const FAMILY_MAX = 64;
const FAMILY_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

/** Whether a name may be written into a stack at all.
 *
 * The record validates the same shape on the way in; this is checked again where
 * text is produced, because the two are reached from different callers and a
 * preview built straight from an input box has not been through the record. A test
 * compares the two answers over the shapes that matter. */
export function isSafeFamilyName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  if (trimmed.length > FAMILY_MAX) return false;
  return FAMILY_PATTERN.test(trimmed.normalize("NFC"));
}

/** One family, as it is written into the stack.
 *
 * Always quoted: `inherit`, `initial` and `unset` are legal-looking names, and an
 * unquoted one of those in front of the tail would reset the property instead of
 * naming a font. Quoting makes every user name a name.
 */
function familyEntry(value: string): string | null {
  // Refused, never repaired: a name with a quote in it is not a family this panel
  // can write, and silently deleting the character would show the user a preview
  // of a name they did not type.
  const trimmed = value.trim();
  if (trimmed === "" || !isSafeFamilyName(trimmed)) return null;
  return `"${trimmed}"`;
}

/** The UI stack: Latin first, then the CJK family, then the authored tail.
 *
 * Order is per-character fallback, not preference: the Latin family is asked first
 * and any glyph it does not hold is asked of the CJK one, so a mixed line is set by
 * both families rather than by whichever one was named.
 */
export function buildUiStack(latin: string, cjk: string): string {
  const named = [latin, cjk].map(familyEntry).filter((one): one is string => one !== null);
  return named.length === 0 ? UI_TAIL : `${named.join(", ")}, ${UI_TAIL}`;
}

/** The stack for commit object IDs and paths. */
export function buildMonoStack(mono: string): string {
  const named = familyEntry(mono);
  return named === null ? MONO_TAIL : `${named}, ${MONO_TAIL}`;
}

/** Every stack value the panel writes, keyed by the custom property it replaces.
 *
 * `resolveMono` is the engine's answer to "does this stack line an object ID up", and
 * measuring that needs a document to lay glyphs out. `fontResolve.ts` supplies it in
 * the panel and a Node run supplies the builder itself, so the pairing of name to
 * stack is stated once, here, and cannot disagree with the value written. */
export function fontStackProperties(
  prefs: {
    latinFont: string;
    cjkFont: string;
    monoFont: string;
  },
  resolveMono: (mono: string) => string = buildMonoStack,
): { "--font-ui": string; "--font-mono": string } {
  return {
    "--font-ui": buildUiStack(prefs.latinFont, prefs.cjkFont),
    "--font-mono": resolveMono(prefs.monoFont),
  };
}
