// Interface zoom and theme. Every rem-based size in the stylesheet follows
// `documentElement.fontSize`; both choices are persisted in the WebView's
// localStorage and restored on startup (M1-09, M7).

const FONT_KEY = "guit.fontPx";
const FONT_MIN = 12;
const FONT_MAX = 24;
const FONT_DEFAULT = 16;

export { FONT_DEFAULT, FONT_MAX, FONT_MIN };

export function currentFontPx(): number {
  const stored = Number(localStorage.getItem(FONT_KEY));
  return stored >= FONT_MIN && stored <= FONT_MAX ? stored : FONT_DEFAULT;
}

export function applyFontPx(px: number): void {
  const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
  document.documentElement.style.fontSize = `${clamped}px`;
  try {
    localStorage.setItem(FONT_KEY, String(clamped));
  } catch {
    // Storage may be unavailable in private mode; scaling still applies.
  }
}

export function initFontPx(): void {
  applyFontPx(currentFontPx());
  // Restore the Settings → General theme choice; "system" (absent) leaves the
  // attribute off so prefers-color-scheme decides.
  try {
    const theme = localStorage.getItem("guit.theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    }
  } catch {
    // Storage may be unavailable in private mode; the system scheme applies.
  }
}
