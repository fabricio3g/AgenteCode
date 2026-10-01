// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { PdfRenderer, pageAtOffset, pageOffset } from './pdf-renderer';
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const renders: Array<{ number: number; scale: number; cancel: ReturnType<typeof vi.fn>; resolve: () => void }> = [];
  const getPage = vi.fn(async (number: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, scale }),
    getTextContent: vi.fn(async () => ({ items: [] })),
    render: vi.fn(({ viewport }: { viewport: { scale: number } }) => {
      const pending = deferred();
      const cancel = vi.fn(() => pending.reject(new Error('cancelled')));
      renders.push({ number, scale: viewport.scale, cancel, resolve: pending.resolve });
      return { promise: pending.promise, cancel } as unknown as RenderTask;
    })
  } as unknown as PDFPageProxy));
  const makeText = vi.fn(() => ({ render: () => Promise.resolve(), cancel: vi.fn() }) as unknown as TextLayer);
  const onError = vi.fn();
  const reader = new PdfRenderer({ getPage } as unknown as PDFDocumentProxy, makeText, onError);
  const mounts = Array.from({ length: 20 }, (_, i) => {
    const canvas = document.createElement('canvas');
    const text = document.createElement('div');
    reader.mount(i + 1, { canvas, text });
    return { canvas, text };
  });
  return { reader, renders, getPage, makeText, onError, mounts };
}
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
describe('PDF viewport scheduler', () => {
  it('registers placeholders without work and renders only the viewport buffer, two at a time', async () => {
    const { reader, getPage, renders } = setup();
    expect(getPage).not.toHaveBeenCalled();
    reader.viewport([3, 4, 5].map(pageNumber => ({ pageNumber, scale: 1 })));
    await settle();
    expect(renders.map(x => x.number)).toEqual([3, 4]);
    renders[0].resolve();
    await settle();
    expect(renders.map(x => x.number)).toEqual([3, 4, 5]);
    reader.dispose();
  });
  it('cancels superseded zoom and waits before reusing the same canvas', async () => {
    const { reader, renders, onError } = setup();
    reader.viewport([{ pageNumber: 1, scale: 1 }]);
    await settle();
    reader.viewport([{ pageNumber: 1, scale: 2 }]);
    expect(renders).toHaveLength(1);
    expect(renders[0].cancel).toHaveBeenCalledOnce();
    await settle();
    expect(renders.map(x => x.scale)).toEqual([1, 2]);
    expect(onError).not.toHaveBeenCalled();
    reader.dispose();
  });
  it('releases pages outside the buffer and stops queued work on disposal', async () => {
    const { reader, renders, mounts, makeText } = setup();
    reader.viewport([{ pageNumber: 1, scale: 1 }]);
    await settle();
    renders[0].resolve();
    await settle();
    expect(makeText).toHaveBeenCalledOnce();
    expect(mounts[0].canvas.width).toBeGreaterThan(0);
    reader.viewport([10, 11, 12].map(pageNumber => ({ pageNumber, scale: 1 })));
    await settle();
    expect(mounts[0].canvas.width).toBe(0);
    reader.dispose();
    await settle();
    expect(renders.map(x => x.number)).toEqual([1, 10, 11]);
    expect(renders[1].cancel).toHaveBeenCalled();
    expect(renders[2].cancel).toHaveBeenCalled();
    reader.viewport([{ pageNumber: 20, scale: 1 }]);
    await settle();
    expect(renders).toHaveLength(3);
  });
  it('ignores an asynchronous page fetch that outlives disposal', async () => {
    const gate = deferred();
    const page = { getViewport: vi.fn(), render: vi.fn() };
    const makeText = vi.fn();
    const reader = new PdfRenderer({ getPage: async () => { await gate.promise; return page; } } as unknown as PDFDocumentProxy, makeText, vi.fn());
    reader.mount(1, { canvas: document.createElement('canvas'), text: document.createElement('div') });
    reader.viewport([{ pageNumber: 1, scale: 1 }]);
    reader.dispose();
    gate.resolve();
    await settle();
    expect(page.render).not.toHaveBeenCalled();
    expect(makeText).not.toHaveBeenCalled();
  });
});
describe('PDF reading geometry', () => {
  const pages = [{ pageNumber: 1, width: 600, height: 800 }, { pageNumber: 2, width: 800, height: 1200 }];
  it('keeps tall pages current until the reading line crosses their bottom', () => {
    expect(pageAtOffset(pages, () => 1, 700).page).toBe(1);
    expect(pageAtOffset(pages, () => 1, 900).page).toBe(2);
  });
  it('round trips the same page and fraction through zoom and fit resize', () => {
    const anchor = pageAtOffset(pages, () => 1, 1400);
    const fitted = (page: { width: number }) => 400 / page.width;
    const offset = pageOffset(pages, fitted, anchor.page, anchor.fraction);
    const restored = pageAtOffset(pages, fitted, offset);
    expect(restored.page).toBe(anchor.page);
    expect(restored.fraction).toBeCloseTo(anchor.fraction);
    expect(pageOffset(pages, () => 2, 2)).toBe(1626);
  });
});
