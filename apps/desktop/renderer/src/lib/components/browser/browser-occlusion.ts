type Bounds = Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;

function overlapsAxis(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd && end > otherStart;
}

/** Only visible overlays with positive intersection cover the native browser view. */
export function overlapsViewport(viewport: Bounds, overlay: Bounds): boolean {
  if (!overlay.width || !overlay.height) return false;
  return overlapsAxis(overlay.left, overlay.right, viewport.left, viewport.right)
    && overlapsAxis(overlay.top, overlay.bottom, viewport.top, viewport.bottom);
}
