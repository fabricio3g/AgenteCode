/** Where a menu panel sits relative to its trigger. */
export type MenuPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const GAP = 6;

/** A zero-size rect at a point (right-click menus, a text caret). */
export function pointRect(x: number, y: number): AnchorRect {
  return { top: y, bottom: y, left: x, right: x };
}

/**
 * Place a floating panel next to an anchor, flipping instead of overflowing
 * the viewport. Shared by Menu and the Code mention picker.
 */
export function placePanel(
  anchor: AnchorRect,
  panel: { width: number; height: number },
  placement: MenuPlacement,
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight }
): { top: number; left: number } {
  const wantsTop = placement.startsWith('top');
  const wantsEnd = placement.endsWith('end');

  let top = wantsTop ? anchor.top - panel.height - GAP : anchor.bottom + GAP;
  let left = wantsEnd ? anchor.right - panel.width : anchor.left;

  if (top < GAP) top = anchor.bottom + GAP;
  if (top + panel.height > viewport.height - GAP) {
    const flipped = anchor.top - panel.height - GAP;
    if (flipped >= GAP) top = flipped;
  }
  left = Math.max(GAP, Math.min(left, viewport.width - panel.width - GAP));
  return { top, left };
}
