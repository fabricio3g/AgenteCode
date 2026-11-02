/**
 * Shared composer autogrow.
 *
 * Single source of truth for textarea sizing, used by the Home composer, the
 * Code composer and the Design dock.
 *
 * Two things it must never do:
 *
 * 1. **Measure before there is a width.** `scrollHeight` on a zero-width
 *    textarea counts every wrapped line, so a measurement taken before layout
 *    settles (first mount, a chat switch, a tab switch) comes back enormous and
 *    clamps to the maximum — the composer then sits open and empty until the
 *    next keystroke shakes it loose.
 * 2. **Stay stale once the width changes.** A pane that narrows, a window that
 *    resizes or a dock that opens re-wraps the text; the height has to follow,
 *    or the field is too short and the text scrolls inside it.
 *
 * So: measure only with a real width, and watch the element for width changes.
 * The observer reacts to width alone — reacting to height would answer its own
 * writes and spin.
 *
 * An empty value clears the inline height so the field falls back to its CSS
 * `min-height`, which is what keeps an empty composer one line tall.
 */
export const MAX_COMPOSER_TEXTAREA_PX = 220;

interface Watch {
  observer: ResizeObserver;
  width: number;
}

const watches = new WeakMap<HTMLTextAreaElement, Watch>();

function measure(element: HTMLTextAreaElement, maxPx: number): void {
  // Not laid out yet: any number here would be a guess, and a wrong one.
  if (!element.isConnected || element.clientWidth <= 0) return;
  element.style.height = 'auto';
  const measured = element.scrollHeight;
  element.style.height = element.value ? `${Math.min(measured, maxPx)}px` : '';
}

export function autogrowTextarea(element: HTMLTextAreaElement, maxPx: number = MAX_COMPOSER_TEXTAREA_PX): void {
  if (typeof ResizeObserver !== 'undefined' && !watches.has(element)) {
    const watch: Watch = { observer: null as unknown as ResizeObserver, width: 0 };
    watch.observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      if (Math.abs(width - watch.width) < 1) return;
      watch.width = width;
      measure(element, maxPx);
    });
    watch.observer.observe(element);
    watches.set(element, watch);
  }

  const watch = watches.get(element);
  if (watch) watch.width = element.clientWidth;
  measure(element, maxPx);
}
