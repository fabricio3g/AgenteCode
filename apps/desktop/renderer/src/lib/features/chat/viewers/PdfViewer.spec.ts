// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentViewer from '../DocumentViewer.svelte';

const pdf = vi.hoisted(() => ({ loads: [] as Array<{ destroy: ReturnType<typeof vi.fn>; resolve: (value: unknown) => void; reject: (error: Error) => void }>, renders: [] as number[] }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const task = { promise, destroy: vi.fn(async () => {}), resolve, reject };
    pdf.loads.push(task);
    return task;
  },
  TextLayer: class {
    constructor(private options: { container: HTMLElement }) {}
    async render() { this.options.container.textContent = 'Selectable PDF text'; }
    cancel() {}
  }
}));
let panelWidth = 600;
let resize: ResizeObserverCallback | undefined;
beforeEach(() => {
  pdf.loads = [];
  pdf.renders = [];
  panelWidth = 600;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => panelWidth);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(600);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) { this.scrollTop = typeof options === 'number' ? y ?? 0 : options?.top ?? 0; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function document(pages = 16) {
  return { numPages: pages, getPage: async (number: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    getTextContent: async () => ({ items: [] }),
    render: () => { pdf.renders.push(number); return { promise: Promise.resolve(), cancel: vi.fn() }; }
  }) };
}
const item = (id: string) => ({ id, name: `${id}.pdf`, dataUrl: 'data:application/pdf;base64,JVBERi0=' });
async function load(view: { container: HTMLElement }, pages = 16) {
  await waitFor(() => expect(pdf.loads.length).toBeGreaterThan(0));
  pdf.loads.at(-1)!.resolve(document(pages));
  await waitFor(() => expect(view.container.querySelectorAll('.pdf-page')).toHaveLength(pages));
  await waitFor(() => expect(pdf.renders.length).toBeGreaterThan(0));
}
describe('PDF reader lifecycle', () => {
  it('renders a small buffer, tracks scrolling, jumps pages and refits after resize', async () => {
    const view = render(DocumentViewer, { doc: item('first') });
    await load(view);
    expect(pdf.renders.length).toBeLessThan(5);
    const scroller = view.container.querySelector('.pdf-page-wrap') as HTMLElement;
    const page = view.container.querySelector('.page-number') as HTMLInputElement;
    scroller.scrollTop = 3000;
    await fireEvent.scroll(scroller);
    await waitFor(() => expect(Number(page.value)).toBeGreaterThan(3));
    await fireEvent.input(page, { target: { value: '10' } });
    await fireEvent.keyDown(page, { key: 'Enter' });
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(6500));
    const before = scroller.scrollTop;
    panelWidth = 400;
    resize?.([], {} as ResizeObserver);
    await waitFor(() => expect((view.container.querySelector('.pdf-page') as HTMLElement).style.width).toBe('376px'));
    await waitFor(() => expect(scroller.scrollTop).toBeLessThan(before));
    expect(Number(page.value)).toBe(10);
    expect(view.container.querySelector('.textLayer')?.hasAttribute('data-viewer-text')).toBe(true);
  });
  it('destroys superseded loads and ignores their late completion', async () => {
    const view = render(DocumentViewer, { doc: item('old') });
    await waitFor(() => expect(pdf.loads).toHaveLength(1));
    const old = pdf.loads[0];
    await view.rerender({ doc: { ...item('old'), dataUrl: 'data:application/pdf;base64,JVBERi0y' } });
    await waitFor(() => expect(pdf.loads).toHaveLength(2));
    expect(old.destroy).toHaveBeenCalledOnce();
    old.resolve(document(8));
    pdf.loads[1].resolve(document(2));
    await waitFor(() => expect(view.container.querySelectorAll('.pdf-page')).toHaveLength(2));
    view.unmount();
    expect(pdf.loads[1].destroy).toHaveBeenCalledOnce();
  });
  it('offers retry after failure and destroys the failed task', async () => {
    const view = render(DocumentViewer, { doc: item('retry') });
    await waitFor(() => expect(pdf.loads).toHaveLength(1));
    pdf.loads[0].reject(new Error('Unreadable PDF'));
    await waitFor(() => expect(view.getByText('Unreadable PDF')).toBeTruthy());
    await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(pdf.loads).toHaveLength(2));
    expect(pdf.loads[0].destroy).toHaveBeenCalledOnce();
    pdf.loads[1].resolve(document(1));
    await waitFor(() => expect(view.container.querySelectorAll('.pdf-page')).toHaveLength(1));
  });
});
