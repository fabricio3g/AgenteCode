// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startPointerGesture } from './pointer-gesture';

let frame: FrameRequestCallback | null;
beforeEach(() => {
  frame = null;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => { frame = null; });
});
afterEach(() => vi.unstubAllGlobals());
function pointer(type: string, x: number) {
  const event = new MouseEvent(type, { clientX: x });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event as PointerEvent;
}
function begin(move: (event: PointerEvent) => void, finish: (cancelled: boolean) => void) {
  const event = pointer('pointerdown', 0);
  Object.defineProperty(event, 'currentTarget', { value: { setPointerCapture() {}, hasPointerCapture: () => false } });
  return startPointerGesture(event, move, finish);
}
it('renders a burst once per frame and flushes the final movement before release', () => {
  const move = vi.fn(), finish = vi.fn(); begin(move, finish);
  for (let i = 1; i <= 100; i++) window.dispatchEvent(pointer('pointermove', i));
  expect(move).not.toHaveBeenCalled();
  frame!(0); expect(move).toHaveBeenCalledTimes(1); expect(move.mock.calls[0][0].clientX).toBe(100);
  window.dispatchEvent(pointer('pointermove', 120)); window.dispatchEvent(pointer('pointerup', 120));
  expect(move).toHaveBeenCalledTimes(2); expect(move.mock.calls[1][0].clientX).toBe(120);
  expect(finish).toHaveBeenCalledWith(false); expect(frame).toBeNull();
});
it('discards pending movement on Escape and on conversation changes', () => {
  for (const cancel of [new KeyboardEvent('keydown', { key: 'Escape' }), new Event('workspace-scope-change')]) {
    const move = vi.fn(), finish = vi.fn(); begin(move, finish);
    window.dispatchEvent(pointer('pointermove', 30)); window.dispatchEvent(cancel);
    expect(move).not.toHaveBeenCalled(); expect(finish).toHaveBeenCalledOnce(); expect(finish).toHaveBeenCalledWith(true);
    expect(frame).toBeNull();
  }
});
