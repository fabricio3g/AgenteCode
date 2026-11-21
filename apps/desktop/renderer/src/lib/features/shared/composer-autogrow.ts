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
/**
 * Fallback cap, in pixels, for a field that cannot report its own.
 *
 * The real cap is CSS: `.composer-textarea` is five rows of its own line box
 * (`--text-prose`, so Settings → Text size moves it). An inline height is only
 * a measurement of the content, and CSS `max-height` clamps it — but writing a
 * number larger than the stylesheet's cap makes the two disagree about where
 * growth stops, so the helper reads the resolved cap back and stays under it.
 */
export const MAX_COMPOSER_TEXTAREA_PX = 220;

/**
 * The cap the stylesheet draws for this field, in pixels.
 *
 * `max-height` resolves against `--text-prose` and the row count, both of which
 * live in CSS; reading the computed value is what keeps this file from having
 * to know either. A detached element has no window to compute against (and a
 * test double has no `ownerDocument`), so those fall back to the constant.
 */
function composerCap(element: HTMLTextAreaElement, fallback: number): number {
  const view = element.ownerDocument?.defaultView;
  if (!view) return fallback;
  const resolved = Number.parseFloat(view.getComputedStyle(element).maxHeight);
  return Number.isFinite(resolved) && resolved > 0 ? resolved : fallback;
}

/** Told, on every real measurement, whether the field is taller than one row. */
type GrownListener = (grown: boolean) => void;

interface Watch {
  observer: ResizeObserver;
  width: number;
  maxPx: number | null;
  onGrown: GrownListener | undefined;
}

const watches = new WeakMap<HTMLTextAreaElement, Watch>();

function measure(
  element: HTMLTextAreaElement,
  maxPx: number | null,
  onGrown: GrownListener | undefined,
): void {
  // Not laid out yet: any number here would be a guess, and a wrong one.
  if (!element.isConnected || element.clientWidth <= 0) return;
  const cap = maxPx === null ? composerCap(element, MAX_COMPOSER_TEXTAREA_PX) : maxPx;
  const view = element.ownerDocument?.defaultView;
  const line = view ? Number.parseFloat(view.getComputedStyle(element).lineHeight) : Number.NaN;
  element.style.height = 'auto';
  const measured = element.scrollHeight;
  element.style.height = element.value ? `${Math.min(measured, cap)}px` : '';
  // One line is the field's floor; anything past it means the row grew and the
  // send square has to follow the last line instead of the first.
  onGrown?.(Boolean(element.value) && Number.isFinite(line) && measured > line + 1);
}

/**
 * @param maxPx Cap the growth at this many pixels. Leave it out to take the
 *               cap the stylesheet gives the field — five rows of its own text,
 *               which is what every composer wants.
 * @param onGrown Called whenever the field's height is measured (mount, input,
 *                width change) with whether it is taller than one row.
 */
export function autogrowTextarea(
  element: HTMLTextAreaElement,
  maxPx: number | null = null,
  onGrown?: GrownListener,
): void {
  if (typeof ResizeObserver !== 'undefined' && !watches.has(element)) {
    const watch: Watch = {
      observer: null as unknown as ResizeObserver,
      width: 0,
      maxPx,
      onGrown,
    };
    watch.observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      if (Math.abs(width - watch.width) < 1) return;
      watch.width = width;
      measure(element, watch.maxPx, watch.onGrown);
    });
    watch.observer.observe(element);
    watches.set(element, watch);
  }

  const watch = watches.get(element);
  if (watch) {
    watch.width = element.clientWidth;
    watch.maxPx = maxPx;
    watch.onGrown = onGrown;
  }
  measure(element, maxPx, onGrown);
}
