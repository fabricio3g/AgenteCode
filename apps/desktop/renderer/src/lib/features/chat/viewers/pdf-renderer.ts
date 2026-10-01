import type { PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist';

export interface PdfPageSize { pageNumber: number; width: number; height: number }
export interface PdfPageMount { canvas: HTMLCanvasElement; text: HTMLDivElement }
interface Job { scale: number; cancelled: boolean; task?: RenderTask; text?: TextLayer }

/** The viewport is the only source of work. At most two pages render at once. */
export class PdfRenderer {
  private mounts = new Map<number, PdfPageMount>();
  private wanted = new Map<number, number>();
  private rendered = new Map<number, number>();
  private running = new Map<number, Job>();
  private disposed = false;

  constructor(
    private document: PDFDocumentProxy,
    private makeTextLayer: (page: ConstructorParameters<typeof TextLayer>[0]) => TextLayer,
    private onError: (error: unknown) => void
  ) {}

  mount(page: number, elements: PdfPageMount) {
    elements.canvas.width = 0;
    elements.canvas.height = 0;
    this.mounts.set(page, elements);
    // Mounting registers placeholders; it never starts a render.
    return () => {
      this.cancel(page);
      this.mounts.delete(page);
      this.rendered.delete(page);
    };
  }

  viewport(pages: Array<{ pageNumber: number; scale: number }>) {
    if (this.disposed) return;
    this.wanted = new Map(pages.map(page => [page.pageNumber, page.scale]));
    for (const [number, job] of this.running) {
      if (this.wanted.get(number) !== job.scale) this.cancel(number);
    }
    for (const number of this.rendered.keys()) {
      if (this.wanted.has(number)) continue;
      this.release(number);
    }
    this.pump();
  }

  private cancel(number: number) {
    const job = this.running.get(number);
    if (!job) return;
    job.cancelled = true;
    job.task?.cancel();
    job.text?.cancel();
  }

  private release(number: number) {
    const mount = this.mounts.get(number);
    if (mount) { mount.canvas.width = 0; mount.canvas.height = 0; mount.text.replaceChildren(); }
    this.rendered.delete(number);
  }

  private current(number: number, job: Job) {
    return !this.disposed && !job.cancelled && this.wanted.get(number) === job.scale && this.mounts.has(number);
  }

  private pump() {
    if (this.disposed) return;
    for (const [number, scale] of this.wanted) {
      if (this.running.size >= 2) break;
      if (!this.mounts.has(number) || this.running.has(number) || this.rendered.get(number) === scale) continue;
      const job: Job = { scale, cancelled: false };
      this.running.set(number, job);
      void this.render(number, job).catch(error => {
        if (this.current(number, job)) { this.wanted.delete(number); this.onError(error); }
      }).finally(() => {
        this.running.delete(number);
        if (!this.wanted.has(number)) this.release(number);
        this.pump();
      });
    }
  }

  private async render(number: number, job: Job) {
    const page = await this.document.getPage(number);
    if (!this.current(number, job)) return;
    const mount = this.mounts.get(number)!;
    const viewport = page.getViewport({ scale: job.scale });
    const outputScale = Math.max(1, window.devicePixelRatio || 1);
    mount.canvas.width = Math.ceil(viewport.width * outputScale);
    mount.canvas.height = Math.ceil(viewport.height * outputScale);
    mount.text.replaceChildren();
    mount.text.style.setProperty('--total-scale-factor', String(job.scale));
    job.task = page.render({ canvas: mount.canvas, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] });
    await job.task.promise;
    if (!this.current(number, job)) return;
    const text = await page.getTextContent();
    if (!this.current(number, job)) return;
    job.text = this.makeTextLayer({ textContentSource: text, container: mount.text, viewport });
    await job.text.render();
    if (this.current(number, job)) this.rendered.set(number, job.scale);
  }

  dispose() {
    this.disposed = true;
    this.wanted.clear();
    for (const number of this.running.keys()) this.cancel(number);
    for (const number of this.mounts.keys()) this.release(number);
    this.mounts.clear();
  }
}

/** Reading line, rather than nearest page edge (which skips tall pages early). */
export function pageAtOffset(pages: PdfPageSize[], scale: (page: PdfPageSize) => number, offset: number, gap = 14) {
  let top = 12;
  for (const page of pages) {
    const bottom = top + page.height * scale(page);
    if (offset < bottom + gap / 2) return { page: page.pageNumber, fraction: Math.max(0, (offset - top) / (bottom - top)) };
    top = bottom + gap;
  }
  return { page: pages.at(-1)?.pageNumber ?? 1, fraction: 1 };
}
export function pageOffset(pages: PdfPageSize[], scale: (page: PdfPageSize) => number, number: number, fraction = 0, gap = 14) {
  let top = 12;
  for (const page of pages) {
    if (page.pageNumber === number) return top + page.height * scale(page) * fraction;
    top += page.height * scale(page) + gap;
  }
  return top;
}
