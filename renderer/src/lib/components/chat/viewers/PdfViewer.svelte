<svelte:options runes={true} />

<script lang="ts">
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';
  import { copy } from '$lib/copy';
  import ViewerStatus from './ViewerStatus.svelte';
  import { readArrayBuffer } from './viewer-source';

  interface Props {
    src: string;
    filename: string;
  }

  let { src, filename }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let pageCount = $state(0);
  type PdfPage = { pageNumber: number; width: number; height: number };

  let currentPage = $state(1);
  let pdfDoc: any = null;
  let pages = $state<PdfPage[]>([]);
  let pageContainer: HTMLDivElement | undefined = $state();
  let canvases = new Map<number, HTMLCanvasElement>();
  let textLayers = new Map<number, HTMLDivElement>();

  let workerReady = false;

  async function ensureWorker() {
    if (workerReady) return;
    const pdfjsLib = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default;
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
      const arrayBuffer = await readArrayBuffer(src, 'PDF');
      if (!arrayBuffer.byteLength) {
        throw new Error('PDF file is empty');
      }
      pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      pageCount = pdfDoc.numPages;
      const nextPages: PdfPage[] = [];
      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        nextPages.push({ pageNumber: pageNum, width: viewport.width, height: viewport.height });
      }
      pages = nextPages;
      requestAnimationFrame(() => renderVisiblePages());
    } catch (err) {
      console.error('[PdfViewer] Failed to load PDF:', err);
      error = err instanceof Error ? err.message : 'PDF preview is not available. Download the file to open it.';
    } finally {
      loading = false;
    }
  }

  function pageScale(page: PdfPage) {
    const availableWidth = Math.max(320, (pageContainer?.clientWidth || window.innerWidth) - 48);
    return Math.min(1.65, availableWidth / page.width);
  }

  async function renderPage(pageNum: number) {
    if (!pdfDoc) return;
    const canvas = canvases.get(pageNum);
    const pageMeta = pages.find((page) => page.pageNumber === pageNum);
    if (!canvas || !pageMeta) return;
    try {
      const cssScale = pageScale(pageMeta);
      const outputScale = Math.max(1, window.devicePixelRatio || 1);
      const page = await pdfDoc.getPage(pageNum);
      const renderViewport = page.getViewport({ scale: cssScale * outputScale });
      const cssViewport = page.getViewport({ scale: cssScale });
      if (canvas.width === Math.floor(renderViewport.width) && canvas.height === Math.floor(renderViewport.height) && canvas.dataset.rendered === 'true') return;
      canvas.width = Math.floor(renderViewport.width);
      canvas.height = Math.floor(renderViewport.height);
      canvas.style.width = `${Math.floor(cssViewport.width)}px`;
      canvas.style.height = `${Math.floor(cssViewport.height)}px`;
      const wrapper = canvas.parentElement;
      if (wrapper) {
        wrapper.style.width = `${Math.floor(cssViewport.width)}px`;
        wrapper.style.height = `${Math.floor(cssViewport.height)}px`;
      }
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, renderViewport.width, renderViewport.height);
      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

      const textLayer = textLayers.get(pageNum);
      if (textLayer) {
        textLayer.innerHTML = '';
        textLayer.style.width = `${Math.floor(cssViewport.width)}px`;
        textLayer.style.height = `${Math.floor(cssViewport.height)}px`;
        const textContent = await page.getTextContent();
        const pdfjsLib = await import('pdfjs-dist');
        await new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport: cssViewport
        }).render();
      }
      canvas.dataset.rendered = 'true';
    } catch (err) {
      console.error('[PdfViewer] Page render failed:', err);
    }
  }

  function renderVisiblePages() {
    if (!pageContainer) return;
    const containerRect = pageContainer.getBoundingClientRect();
    for (const page of pages) {
      const canvas = canvases.get(page.pageNumber);
      const wrapper = canvas?.parentElement;
      if (!wrapper) continue;
      const rect = wrapper.getBoundingClientRect();
      if (rect.bottom >= containerRect.top - 900 && rect.top <= containerRect.bottom + 900) {
        void renderPage(page.pageNumber);
      }
    }
  }

  function goToPage(pageNum: number) {
    if (pageNum < 1 || pageNum > pageCount) return;
    currentPage = pageNum;
    canvases.get(pageNum)?.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function registerCanvas(node: HTMLCanvasElement, pageNum: number) {
    canvases.set(pageNum, node);
    requestAnimationFrame(() => renderPage(pageNum));
    return {
      destroy() {
        canvases.delete(pageNum);
      }
    };
  }

  function registerTextLayer(node: HTMLDivElement, pageNum: number) {
    textLayers.set(pageNum, node);
    requestAnimationFrame(() => renderPage(pageNum));
    return {
      destroy() {
        textLayers.delete(pageNum);
      }
    };
  }

  function handleScroll() {
    renderVisiblePages();
    if (!pageContainer) return;
    const containerTop = pageContainer.getBoundingClientRect().top;
    let nearest = currentPage;
    let nearestDistance = Infinity;
    for (const [pageNum, canvas] of canvases) {
      const wrapper = canvas.parentElement;
      if (!wrapper) continue;
      const distance = Math.abs(wrapper.getBoundingClientRect().top - containerTop - 12);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = pageNum;
      }
    }
    currentPage = nearest;
  }

  $effect(() => {
    loadPdf();
  });
</script>

<div class="pdf-viewer">
  {#if loading || error}
    <ViewerStatus {loading} {error} label={copy.viewer.loadingPdf} />
  {:else if pageCount > 0}
    <div class="pdf-nav">
      <button class="pdf-nav-btn" onclick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1}>
        <ChevronLeft class="h-3.5 w-3.5" />
      </button>
      <span class="pdf-page-info">{currentPage} / {pageCount}</span>
      <button class="pdf-nav-btn" onclick={() => goToPage(currentPage + 1)} disabled={currentPage >= pageCount}>
        <ChevronRight class="h-3.5 w-3.5" />
      </button>
    </div>
    <div class="pdf-page-wrap" bind:this={pageContainer} onscroll={handleScroll}>
      <div class="pdf-pages">
        {#each pages as page (page.pageNumber)}
          <div class="pdf-page" style={`aspect-ratio:${page.width}/${page.height};`}>
            <canvas use:registerCanvas={page.pageNumber} class="pdf-canvas"></canvas>
            <div use:registerTextLayer={page.pageNumber} class="textLayer pdf-text-layer" aria-hidden="true"></div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .pdf-viewer {
    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    gap: 0.4rem;
  }



  .pdf-nav {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.55rem;
    border-radius: 0.8rem;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    padding: 0.45rem;
    backdrop-filter: blur(10px);
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
    width: 1.85rem;
    height: 1.85rem;
    border: 1px solid transparent;
    border-radius: 0.6rem;
    color: var(--text-tertiary);
    background:
      linear-gradient(var(--surface), var(--surface)) padding-box,
      linear-gradient(180deg, rgba(255,255,255,0.72), rgba(142,151,168,0.5), rgba(255,255,255,0.45)) border-box;
    transition: filter 150ms ease, color 150ms ease, transform 150ms ease;
  }

  .pdf-nav-btn:hover:not(:disabled) {
    color: var(--text);
    filter: brightness(1.04);
    transform: translateY(-1px);
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
    flex: 1;
    min-height: 0;
    background: color-mix(in srgb, var(--chat-bg) 62%, var(--surface));
    border-radius: 0.9rem;
    overflow: auto;
    padding: 0.75rem;
  }

  .pdf-pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.85rem;
    min-height: 100%;
  }

  .pdf-page {
    position: relative;
    display: flex;
    width: fit-content;
    max-width: 100%;
    align-items: center;
    justify-content: center;
    background: white;
    box-shadow: var(--shadow-sm);
  }

  .pdf-canvas {
    display: block;
    width: 100%;
    height: auto;
    background: white;
    user-select: none;
  }

  .pdf-text-layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    line-height: 1;
    text-align: initial;
    transform-origin: 0 0;
    user-select: text;
    z-index: 2;
  }

  .pdf-text-layer :global(span),
  .pdf-text-layer :global(br) {
    position: absolute;
    color: transparent;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
  }

  .pdf-text-layer :global(::selection) {
    background: color-mix(in srgb, var(--primary) 32%, transparent);
  }
</style>
