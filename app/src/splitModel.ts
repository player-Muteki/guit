// The share of the main panel given to the changes area.
//
// Pure: no DOM, no Git, no stylesheet. The panel's own element applies the
// result as `--main-split`, and a Node run can check the clamps without a
// window to draw in.

export const SPLIT_DEFAULT = 45;
export const SPLIT_MIN = 15;
export const SPLIT_MAX = 85;
// A keyboard nudge. Arrows are for a precise adjustment, Page keys for a
// jump across the panel; both stop at the same bounds as the pointer.
export const SPLIT_STEP = 2;
export const SPLIT_PAGE = 10;

export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
}

// A stored value is only trusted after the clamp: a panel height written by an
// older build, or edited by hand, must not leave one region with no rows in it.
export function readStoredSplit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return SPLIT_DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampSplit(parsed) : SPLIT_DEFAULT;
}

export function stepSplit(value: number, delta: number): number {
  return clampSplit(value + delta);
}

export interface SplitGeometry {
  changesTop: number;
  regionsHeight: number;
  grabOffset: number;
}

export function splitFromPointer(pointerY: number, geometry: SplitGeometry): number {
  const { changesTop, regionsHeight, grabOffset } = geometry;
  if (!(regionsHeight > 0) || !Number.isFinite(regionsHeight)) return SPLIT_DEFAULT;
  return clampSplit(((pointerY - changesTop - grabOffset) / regionsHeight) * 100);
}
