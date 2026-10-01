// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { panScroll, readerScrollBehavior } from './pan-scroll';
import { reducedMotion } from '$lib/utils/motion.svelte';
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
function setup() {
  const root = document.createElement('div');
  root.innerHTML = '<div data-viewer-text><span>Selectable text</span></div><div class="gutter"></div>';
  Object.defineProperties(root, { scrollHeight: { value: 2000 }, clientHeight: { value: 600 } });
  root.setPointerCapture = vi.fn();
  root.hasPointerCapture = vi.fn(() => true);
  root.releasePointerCapture = vi.fn();
  document.body.append(root);
  return { root, action: panScroll(root) };
}
function pointer(target: Element, type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { button: 0, pointerType: 'mouse', pointerId: 1, clientX: x, clientY: y });
  target.dispatchEvent(event);
}
it('gives selectable text precedence over panning', () => {
  const { root, action } = setup();
  const clear = vi.spyOn(window.getSelection()!, 'removeAllRanges');
  pointer(root.querySelector('span')!, 'pointerdown', 40, 100);
  pointer(root, 'pointermove', 70, 200);
  expect(root.setPointerCapture).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  expect(root.scrollTop).toBe(0);
  action.destroy();
});
it('still pans from the gutter and removes gesture handlers on unmount', () => {
  const { root, action } = setup();
  pointer(root.querySelector('.gutter')!, 'pointerdown', 40, 200);
  pointer(root, 'pointermove', 40, 100);
  expect(root.scrollTop).toBe(100);
  expect(root.setPointerCapture).toHaveBeenCalledOnce();
  pointer(root, 'pointerup', 40, 100);
  expect(root.releasePointerCapture).toHaveBeenCalledOnce();
  action.destroy();
  pointer(root.querySelector('.gutter')!, 'pointerdown', 40, 200);
  pointer(root, 'pointermove', 40, 100);
  expect(root.scrollTop).toBe(100);
});

it('respects reduced motion for page navigation', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  reducedMotion.value = true;
  expect(readerScrollBehavior()).toBe('instant');
  reducedMotion.value = false;
  expect(readerScrollBehavior()).toBe('smooth');
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  expect(readerScrollBehavior()).toBe('instant');
  vi.unstubAllGlobals();
});
