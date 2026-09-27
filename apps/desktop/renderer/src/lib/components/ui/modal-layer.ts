/**
 * One behaviour for every modal surface in the app.
 *
 * Modals used to each roll their own backdrop: some closed on Escape, most did
 * not; none trapped focus or gave it back; each picked its own z-index. This
 * action is the single implementation. Put it on the backdrop element:
 *
 *   <div class="aui-modal-backdrop" use:modalLayer={{ onclose }}> … </div>
 *
 * - Layers stack: only the topmost handles Escape, and each layer's z-index is
 *   `--z-modal` plus its depth, so a dialog opened from a dialog sits on top.
 * - Focus moves into the layer (first `[autofocus]`, else the first focusable
 *   element, else the surface), Tab cycles inside it, and focus returns to
 *   whatever had it before the layer opened.
 * - The page behind does not scroll while any layer is open.
 */

export interface ModalLayerOptions {
  /** Called on Escape. Omit to make Escape a no-op (e.g. a blocking step). */
  onclose?: () => void;
  /** z-index token the layer stacks from. Confirmations use `--z-confirm`. */
  zToken?: '--z-modal' | '--z-confirm' | '--z-drawer';
  /** Skip moving focus in (e.g. a drawer that should not steal the caret). */
  autoFocus?: boolean;
}

interface Layer {
  node: HTMLElement;
  options: ModalLayerOptions;
  restoreFocus: HTMLElement | null;
}

const stack: Layer[] = [];
let savedOverflow: string | null = null;

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]'
].join(',');

function focusables(node: HTMLElement): HTMLElement[] {
  // Layout-free visibility test: hidden/inert subtrees and display:none
  // ancestors marked by the component are skipped.
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.style.display !== 'none'
  );
}

function isTop(layer: Layer): boolean {
  return stack[stack.length - 1] === layer;
}

function onKeydown(event: KeyboardEvent) {
  const layer = stack[stack.length - 1];
  if (!layer) return;
  if (event.key === 'Escape') {
    // A menu or picker inside the layer handles its own Escape first.
    if (event.defaultPrevented) return;
    if (!layer.options.onclose) return;
    event.preventDefault();
    event.stopPropagation();
    layer.options.onclose();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusables(layer.node);
  if (!items.length) {
    event.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active && layer.node.contains(active);
  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !inside)) {
    event.preventDefault();
    first.focus();
  }
}

function lockScroll() {
  if (savedOverflow !== null || typeof document === 'undefined') return;
  savedOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  // Bubble phase on window: menus inside a layer listen in capture on the
  // document and stop the event, so their Escape never reaches this one.
  window.addEventListener('keydown', onKeydown);
}

function unlockScroll() {
  if (stack.length || savedOverflow === null) return;
  document.body.style.overflow = savedOverflow;
  savedOverflow = null;
  window.removeEventListener('keydown', onKeydown);
}

function applyDepth() {
  stack.forEach((layer, index) => {
    const token = layer.options.zToken ?? '--z-modal';
    layer.node.style.zIndex = `calc(var(${token}) + ${index})`;
  });
}

function focusInto(layer: Layer) {
  if (layer.options.autoFocus === false) return;
  const node = layer.node;
  if (node.contains(document.activeElement)) return;
  const preferred = node.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
  const target = preferred ?? focusables(node)[0] ?? node.querySelector<HTMLElement>('[role="dialog"]') ?? node;
  if (!target.hasAttribute('tabindex') && !focusables(node).includes(target)) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

export function modalLayer(node: HTMLElement, options: ModalLayerOptions = {}) {
  const layer: Layer = {
    node,
    options,
    restoreFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null
  };
  stack.push(layer);
  lockScroll();
  applyDepth();
  // Content renders in the same tick; focus once it is in the DOM.
  queueMicrotask(() => {
    if (isTop(layer)) focusInto(layer);
  });

  return {
    update(next: ModalLayerOptions = {}) {
      layer.options = next;
      applyDepth();
    },
    destroy() {
      const index = stack.indexOf(layer);
      if (index >= 0) stack.splice(index, 1);
      applyDepth();
      unlockScroll();
      const target = layer.restoreFocus;
      if (target && target.isConnected) target.focus({ preventScroll: true });
    }
  };
}

/** Test hook: how many layers are open. */
export function openModalLayerCount(): number {
  return stack.length;
}
