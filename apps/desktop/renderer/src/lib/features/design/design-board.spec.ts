// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignComment, DesignSelection } from '$shared/design';

vi.mock('$lib/services/bridge', () => ({
  invoke: vi.fn(async (channel: string) => channel === 'design_files'
    ? { files: { 'index.html': '<h1>Hi</h1>', 'pricing.html': '<h1>$</h1>' }, pages: ['index.html', 'pricing.html'], variants: [] }
    : []),
  listen: vi.fn(async () => () => {})
}));

const { designStore } = await import('./design.svelte');
const { formatTurnContext } = await import('./design-picker');
const { BOARD_GAP } = await import('./design-view');

beforeEach(async () => {
  await designStore.open(null);
  await designStore.open(`chat-${Math.random()}`);
  designStore.sizes = ['desktop'];
  designStore.pane = { width: 1000, height: 800 };
});

describe('the board in the store', () => {
  it('draws every page at every chosen size and keeps at least one size', () => {
    expect(designStore.board.frames.map((frame) => frame.key)).toEqual(['desktop:index.html', 'desktop:pricing.html']);
    designStore.toggleSize('mobile');
    expect(designStore.sizes).toEqual(['desktop', 'mobile']);
    expect(designStore.board.frames).toHaveLength(4);
    designStore.toggleSize('desktop');
    designStore.toggleSize('mobile');
    expect(designStore.sizes).toEqual(['mobile']);
  });

  it('opens fitted, zooms around a point and pans as an explicit view', () => {
    expect(designStore.zoom).toBeNull();
    const fitted = designStore.view;
    expect(fitted.scale).toBeLessThan(1);
    designStore.setZoom(1, { x: 0, y: 0 });
    expect(designStore.view.scale).toBe(1);
    designStore.panBy(30, -10);
    expect(designStore.view).toMatchObject({ x: designStore.pan.x, y: designStore.pan.y });
    const before = designStore.view;
    designStore.panBy(5, 5);
    expect(designStore.view.x).toBe(before.x + 5);
    designStore.setZoom(null);
    expect(designStore.view).toEqual(fitted);
  });

  it('focuses one frame: its page becomes the selected one, filling the pane', () => {
    designStore.focusFrame('desktop:pricing.html');
    expect(designStore.selected).toBe('pricing.html');
    const frame = designStore.board.frames.find((item) => item.key === 'desktop:pricing.html')!;
    expect(frame.y).toBe(900 + BOARD_GAP.row);
    expect(designStore.activeFrame?.key).toBe('desktop:pricing.html');
    // The frame sits inside the pane at the focused view.
    const left = designStore.view.x + frame.x * designStore.view.scale;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + frame.width * designStore.view.scale).toBeLessThanOrEqual(1000);
    // A narrower frame of the page becomes the active one once it is focused; picking the page alone falls back to the widest.
    designStore.toggleSize('mobile');
    designStore.focusFrame('mobile:pricing.html');
    expect(designStore.activeFrame?.key).toBe('mobile:pricing.html');
    designStore.select('index.html');
    expect(designStore.activeFrame?.key).toBe('desktop:index.html');
  });

  it('keeps a dragged frame where it was left, per design, until the board is tidied', () => {
    designStore.moveFrame('desktop:pricing.html', 1800, -400);
    // A fitted board holds still while a frame moves instead of refitting under the pointer.
    expect(designStore.zoom).not.toBeNull();
    designStore.endMove();
    expect(designStore.board.frames[1]).toMatchObject({ x: 1800, y: -400 });
    expect(designStore.board.y).toBe(-400);
    expect(JSON.parse(localStorage.getItem(`agente.design.board.${designStore.chatId}`) || '{}')).toEqual({ 'desktop:pricing.html': { x: 1800, y: -400 } });
    designStore.tidyBoard();
    expect(designStore.board.frames[1].x).toBe(0);
    expect(designStore.zoom).toBeNull();
    expect(localStorage.getItem(`agente.design.board.${designStore.chatId}`)).toBeNull();
  });

  it('tags a pick with the page and width of the frame it came from', () => {
    designStore.addSelection({ selector: 'h1', tag: 'h1', text: 'Hi', html: '<h1>Hi</h1>', box: { x: 0, y: 0, width: 10, height: 10 }, styles: {} }, false, 'pricing.html', 390);
    expect(designStore.selection[0]).toMatchObject({ page: 'pricing.html', width: 390 });
  });
});

describe('frame width in the turn context', () => {
  it('names the frame a pick or a comment was made in', () => {
    const pick: DesignSelection = { id: 's', page: 'index.html', width: 390, selector: 'h1', tag: 'h1', text: '', html: '<h1></h1>', box: { x: 0, y: 0, width: 1, height: 1 }, styles: {} };
    const comment: DesignComment = { id: 'c', page: 'index.html', width: 390, selector: 'h1', x: 0, y: 0, note: 'Smaller on phones' };
    const text = formatTurnContext([pick], [comment]);
    expect(text).toContain('in the 390px frame');
    expect(text).toContain('index.html at 390px, near `h1`: Smaller on phones');
  });
});
