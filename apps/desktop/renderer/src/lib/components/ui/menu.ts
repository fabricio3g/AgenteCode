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
): { top: number; left: number; maxHeight: number; maxWidth: number } {
  const wantsTop = placement.startsWith('top');
  const wantsEnd = placement.endsWith('end');

  const maxWidth = Math.max(0, viewport.width - GAP * 2);
  const viewportHeight = Math.max(0, viewport.height - GAP * 2);
  const above = Math.max(0, Math.min(viewportHeight, anchor.top - GAP * 2));
  const below = Math.max(0, Math.min(viewportHeight, viewport.height - anchor.bottom - GAP * 2));
  const preferred = wantsTop ? above : below;
  const opposite = wantsTop ? below : above;
  const useTop = panel.height <= preferred || preferred >= opposite ? wantsTop : !wantsTop;
  const maxHeight = useTop ? above : below;
  const height = Math.min(panel.height, maxHeight);
  const width = Math.min(panel.width, maxWidth);
  const top = Math.max(GAP, Math.min(useTop ? anchor.top - height - GAP : anchor.bottom + GAP, viewport.height - height - GAP));
  const left = Math.max(GAP, Math.min(wantsEnd ? anchor.right - width : anchor.left, viewport.width - width - GAP));
  return { top, left, maxHeight, maxWidth };
}
