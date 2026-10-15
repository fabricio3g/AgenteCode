/**
 * Where a menu panel sits relative to its trigger. `right-*` opens beside the
 * anchor (a submenu): `start` aligns the tops, `end` the bottoms.
 */
export type MenuPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'right-end';

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
  if (placement.startsWith('right')) return placeBeside(anchor, panel, placement === 'right-end', viewport);
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

/** Beside the anchor, on the right unless only the left has room; slid to stay on screen. */
function placeBeside(
  anchor: AnchorRect,
  panel: { width: number; height: number },
  alignBottom: boolean,
  viewport: { width: number; height: number }
): { top: number; left: number; maxHeight: number; maxWidth: number } {
  const maxHeight = Math.max(0, viewport.height - GAP * 2);
  const right = viewport.width - anchor.right - GAP * 2;
  const leftRoom = anchor.left - GAP * 2;
  const onRight = panel.width <= right || right >= leftRoom;
  const maxWidth = Math.max(0, onRight ? right : leftRoom);
  const width = Math.min(panel.width, maxWidth);
  const height = Math.min(panel.height, maxHeight);
  const left = onRight ? anchor.right + GAP : anchor.left - GAP - width;
  const wanted = alignBottom ? anchor.bottom - height : anchor.top;
  const top = Math.max(GAP, Math.min(wanted, viewport.height - height - GAP));
  return { top, left: Math.max(GAP, left), maxHeight, maxWidth };
}
