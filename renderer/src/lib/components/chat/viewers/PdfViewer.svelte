<svelte:options runes={true} />

<script lang="ts">
  import { ChevronLeft, ChevronRight, Loader2, AlertCircle, Minus, Plus } from 'lucide-svelte';

  interface Props {
    src: string;
    filename: string;
  }

  let { src, filename }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let pageCount = $state(0);
  let currentPage = $state(1);
  let zoom = $state(1.25);
  let pdfDoc: any = null;
  let canvasEl: HTMLCanvasElement | undefined = $state();

  let workerReady = false;

  async function ensureWorker() {
    if (workerReady) return;
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url
    ).href;
    workerReady = true;
  }

  async function loadPdf() {
    loading = true;
    error = null;
    currentPage = 1;
    pdfDoc = null;
    try {
      if (!src) {
        throw new Error('No PDF source available');
      }
      await ensureWorker();
      const pdfjsLib = await import('pdfjs-dist');
      const response = await fetch(src);
      if (!response.ok) {
        throw new Error(`PDF request failed (${response.status})`);
      }
      const arrayBuffer = await response.arrayBuffer();
      if (!arrayBuffer.byteLength) {
        throw new Error('PDF file is empty');
      }
      pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      pageCount = pdfDoc.numPages;
      await renderPage(1);
    } catch (err) {
      console.error('[PdfViewer] Failed to load PDF:', err);
      error = 'PDF preview is not available. Download the file to open it.';
    } finally {
      loading = false;
    }
  }

  async function renderPage(pageNum: number) {
    if (!pdfDoc || !canvasEl) return;
    try {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: zoom });
      canvasEl.width = viewport.width;
      canvasEl.height = viewport.height;
      const ctx = canvasEl.getContext('2d')!;
      ctx.clearRect(0, 0, viewport.width, viewport.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (err) {
      console.error('[PdfViewer] Page render failed:', err);
    }
  }

  function goToPage(pageNum: number) {
    if (pageNum < 1 || pageNum > pageCount) return;
    currentPage = pageNum;
    renderPage(pageNum);
  }

  function setZoom(next: number) {
    zoom = Math.max(0.75, Math.min(2.2, next));
    renderPage(currentPage);
  }

  $effect(() => {
    loadPdf();
  });
</script>

<div class="pdf-viewer">
  {#if loading}
    <div class="pdf-status">
      <Loader2 class="h-4 w-4 animate-spin" />
      <span>Loading PDF...</span>
    </div>
  {:else if error}
    <div class="pdf-status error">
      <AlertCircle class="h-4 w-4" />
      <span>{error}</span>
    </div>
  {:else if pageCount > 0}
    <div class="pdf-nav">
      <button class="pdf-nav-btn" onclick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1}>
        <ChevronLeft class="h-3.5 w-3.5" />
      </button>
      <span class="pdf-page-info">Page {currentPage} of {pageCount}</span>
      <button class="pdf-nav-btn" onclick={() => goToPage(currentPage + 1)} disabled={currentPage >= pageCount}>
        <ChevronRight class="h-3.5 w-3.5" />
      </button>
      <span class="pdf-divider"></span>
      <button class="pdf-nav-btn" onclick={() => setZoom(zoom - 0.15)} title="Zoom out">
        <Minus class="h-3.5 w-3.5" />
      </button>
      <span class="pdf-page-info">{Math.round(zoom * 100)}%</span>
      <button class="pdf-nav-btn" onclick={() => setZoom(zoom + 0.15)} title="Zoom in">
        <Plus class="h-3.5 w-3.5" />
      </button>
    </div>
    <div class="pdf-page-wrap">
      <canvas bind:this={canvasEl} class="pdf-canvas"></canvas>
    </div>
  {/if}
</div>

<style>
  .pdf-viewer {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .pdf-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .pdf-status.error {
    color: var(--error);
  }

  .pdf-nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
  }

  .pdf-divider {
    width: 1px;
    height: 1rem;
    background: var(--border);
  }

  .pdf-nav-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    padding: 0.25rem;
    color: var(--text-tertiary);
    transition: background 150ms ease, color 150ms ease;
  }

  .pdf-nav-btn:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text);
  }

  .pdf-nav-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .pdf-page-info {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .pdf-page-wrap {
    display: flex;
    justify-content: center;
    background: var(--surface);
    border-radius: var(--radius-sm);
    overflow: auto;
    max-height: calc(96vh - 9rem);
  }

  .pdf-canvas {
    display: block;
    max-width: 100%;
    height: auto;
  }
</style>
