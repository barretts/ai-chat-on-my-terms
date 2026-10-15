/**
 * T119 — iPhone responsive layout (UI-10): landscape two-column
 * layout, dynamic type scaling, and the native touch-target and
 * keyboard/focus-order audits.
 */

export interface IphoneViewport {
  widthPt: number;
  heightPt: number;
}

export const MIN_TOUCH_TARGET_PT = 44;

/** Dynamic type: growth honored, clamped so chat layout never
 * collapses (larger-AX sizes still navigate). */
export const DYNAMIC_TYPE_MAX_MULTIPLIER = 2;

export function isLandscape(viewport: IphoneViewport): boolean {
  return viewport.widthPt > viewport.heightPt;
}

/** UI-10: landscape iPhone runs the two-column layout (list |
 * detail); portrait stays one column. */
export function columnCount(viewport: IphoneViewport): 1 | 2 {
  return isLandscape(viewport) ? 2 : 1;
}

export function scaledFontSize(basePt: number, multiplier: number): number {
  const m =
    Number.isFinite(multiplier) && multiplier > 1
      ? Math.min(multiplier, DYNAMIC_TYPE_MAX_MULTIPLIER)
      : 1;
  return Math.round(basePt * m * 10) / 10;
}

export interface TargetSpec {
  id: string;
  widthPt: number;
  heightPt: number;
}

/** Step 3 audit: any native control under 44x44pt is reported. */
export function touchTargetViolations(
  targets: readonly TargetSpec[],
): string[] {
  return targets
    .filter((t) => t.widthPt < MIN_TOUCH_TARGET_PT || t.heightPt < MIN_TOUCH_TARGET_PT)
    .map((t) => t.id);
}

export interface FocusStep {
  id: string;
  tabIndex: number;
}

/** Step 3 audit: keyboard/focus traversal must advance strictly; a
 * repeat or backwards tabIndex strands keyboard users. */
export function focusOrderViolations(steps: readonly FocusStep[]): string[] {
  const bad: string[] = [];
  let prev: number | undefined;
  for (const step of steps) {
    if (prev !== undefined && step.tabIndex <= prev) bad.push(step.id);
    prev = step.tabIndex;
  }
  return bad;
}
