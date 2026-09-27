/**
 * Moving around a zoomed document: drag to pan once the content is larger
 * than the view, and Ctrl/⌘ + wheel to zoom. A plain wheel still scrolls.
 *
 * Panning starts only after a few pixels of movement, so a click still places
 * the caret and a double-click still selects a word.
 */

const DRAG_THRESHOLD = 4;

export interface PanScrollOptions {
  /** Ctrl/⌘ + wheel: +1 zooms in, -1 zooms out. */
  onzoom?: (direction: 1 | -1) => void;
}

function overflows(node: HTMLElement): boolean {
  return node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
}

export function panScroll(node: HTMLElement, initial: PanScrollOptions = {}) {
  let options = initial;
  let start: { x: number; y: number; left: number; top: number; id: number } | null = null;
  let panning = false;

  const refreshCursor = () => node.classList.toggle('can-pan', node.scrollWidth > node.clientWidth + 1);

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || event.pointerType === 'touch' || !overflows(node)) return;
    if ((event.target as HTMLElement).closest('input, textarea, button, a, select')) return;
    start = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop, id: event.pointerId };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!panning) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      panning = true;
      node.setPointerCapture(event.pointerId);
      node.classList.add('is-panning');
      window.getSelection()?.removeAllRanges();
    }
    event.preventDefault();
    node.scrollLeft = start.left - dx;
    node.scrollTop = start.top - dy;
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.id) return;
    if (panning && node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    start = null;
    panning = false;
    node.classList.remove('is-panning');
  };

  const onWheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey) || !options.onzoom) return;
    event.preventDefault();
    options.onzoom(event.deltaY < 0 ? 1 : -1);
  };

  // Absent in some test environments; the cursor hint is all they drive.
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refreshCursor);
  resize?.observe(node);
  const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(refreshCursor);
  mutations?.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', onPointerUp);
  node.addEventListener('wheel', onWheel, { passive: false });

  return {
    update(next: PanScrollOptions) {
      options = next;
    },
    destroy() {
      resize?.disconnect();
      mutations?.disconnect();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerUp);
      node.removeEventListener('wheel', onWheel);
    }
  };
}

/**
 * Change the zoom of a scroll container's content while keeping the point at
 * the centre of the view where it is. Without this every zoom snaps to the
 * top-left corner, so zooming in shows the margin instead of the text.
 */
export async function zoomAroundCenter(node: HTMLElement | undefined, apply: () => void, settle: () => Promise<void>) {
  if (!node) {
    apply();
    return;
  }
  const x = node.scrollWidth > 0 ? (node.scrollLeft + node.clientWidth / 2) / node.scrollWidth : 0.5;
  const y = node.scrollHeight > 0 ? (node.scrollTop + node.clientHeight / 2) / node.scrollHeight : 0;
  apply();
  await settle();
  node.scrollLeft = x * node.scrollWidth - node.clientWidth / 2;
  node.scrollTop = y * node.scrollHeight - node.clientHeight / 2;
}
