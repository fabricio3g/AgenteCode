// @vitest-environment jsdom
// The export path's two shapes: an uploaded bitmap is inlined, a blank board is
// painted. Only the SVG builder is exercised here — rasterizing needs a DOM and
// the imports are the daemon's job — but the builder is where a board could
// silently come out as a transparent rectangle.

import { describe, expect, it, vi } from 'vitest';
import type { CanvasImage, CanvasMark } from './canvas-doc';

vi.mock('$lib/services/bridge', () => ({ invoke: vi.fn() }));
const fakeApp = vi.hoisted(() => ({ chats: [{ id: 'chat-a', codeAgent: false }], currentChat: { id: 'chat-a', codeAgent: false }, composer: 'Existing', pendingAttachments: [], updateComposer: vi.fn() }));
vi.mock('$lib/stores/app.svelte', () => ({ appStore: fakeApp }));
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore: { error: vi.fn(), success: vi.fn() } }));
vi.mock('./canvas-board.svelte', () => ({ canvasBoard: { doc: { images: [], marks: [], view: { zoom: 1, panX: 0, panY: 0 }, labelled: [] } } }));

const { entrySvg, handOffToAgent } = await import('./canvas-handoff');

const bitmap: CanvasImage = { id: 'img1', path: '/root/.agente/attachments/a.png', name: 'shot.png', w: 1000, h: 500 };
const board: CanvasImage = { id: 'board1', name: 'whiteboard.png', w: 1600, h: 1000 };

function stroke(over: Partial<CanvasMark> = {}): CanvasMark {
  return { id: 'm1', imageId: 'board1', kind: 'freehand', x: 10, y: 20, w: 100, h: 60, points: [[10, 20], [110, 80]], color: '#ef4444', width: 4, opacity: 1, ...over };
}

describe('a piece of the board as SVG', () => {
  it('inlines an uploaded image over the full board', () => {
    const svg = entrySvg(bitmap, 'data:image/png;base64,AAAA', { imageId: 'img1', box: null, marks: [stroke({ imageId: 'img1' })] });
    expect(svg).toContain('<image href="data:image/png;base64,AAAA" x="0" y="0" width="1000" height="500" />');
    expect(svg).toContain('viewBox="0 0 1000 500"');
    expect(svg).not.toContain('<rect x="0" y="0" width="1000" height="500" fill="#ffffff" />');
    expect(svg).toContain('stroke="#ef4444"');
  });

  it('paints white paper for a blank board and never emits an image tag', () => {
    const svg = entrySvg(board, null, { imageId: 'board1', box: null, marks: [stroke()] });
    expect(svg).toContain('<rect x="0" y="0" width="1600" height="1000" fill="#ffffff" />');
    expect(svg).not.toContain('<image');
    expect(svg).toContain('viewBox="0 0 1600 1000"');
    expect(svg).toContain('<path d="M10 20 L110 80"');
  });

  it('crops to the entry box and keeps the paper under the marks', () => {
    const svg = entrySvg(board, null, { imageId: 'board1', box: { x: 0, y: 0, w: 200, h: 120 }, marks: [stroke()] });
    expect(svg).toContain('width="200" height="120" viewBox="0 0 200 120"');
    expect(svg).toContain('fill="#ffffff"');
  });

  it('renders a board with no marks at all', () => {
    const svg = entrySvg(board, null, { imageId: 'board1', box: null, marks: [] });
    expect(svg).toContain('fill="#ffffff"');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });
});

it('exports arrows in the direction drawn, including a horizontal reverse arrow', () => {
  const svg = entrySvg(board, null, { imageId: 'board1', box: null, marks: [stroke({ kind: 'arrow', x: 10, y: 20, w: 100, h: 0, points: [[110, 20], [10, 20]] })] });
  expect(svg).toContain('d="M110 20 L10 20"');
});
it('keeps an asynchronous canvas handoff in its owning conversation', () => {
  expect(handOffToAgent('Instructions', [], 'chat-b')).toBe(false);
  expect(fakeApp.updateComposer).not.toHaveBeenCalled();
  expect(handOffToAgent('Instructions', [], 'chat-a')).toBe(true);
  expect(fakeApp.updateComposer).toHaveBeenCalledWith('Existing\n\nInstructions');
});
