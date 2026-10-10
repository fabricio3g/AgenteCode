<script lang="ts">
  import { observeViewerSize } from './viewer-layout';
  import { tick } from 'svelte';
  import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
  import { t } from 'svelte-i18n';
  import { panScroll, readerScrollBehavior } from './pan-scroll';
  import ViewerStatus from './ViewerStatus.svelte';
  import { readArrayBuffer } from './viewer-source';
  import { registerViewerControls, useViewerControls } from './viewer-controls.svelte';
  import { pageAtOffset, pageOffset, PdfRenderer, type PdfPageSize } from './pdf-renderer';
  import type { PDFDocumentProxy } from 'pdfjs-dist';
  import { createViewerFind } from './viewer-find.svelte';
  import { pdfTextLines } from '$shared/pdf-text';

  let { src, filename }: { src: string; filename: string } = $props();
  const controls = useViewerControls();
  let loading = $state(true);
  let error = $state<string | null>(null);
  let pages = $state<PdfPageSize[]>([]);
  let currentPage = $state(1);
  let manualZoom = $state<number | null>(null);
  let width = $state(0);
  let pageContainer = $state<HTMLDivElement>();
  let revision = $state(0);
  let renderer = $state.raw<PdfRenderer>();
  let searchDocument = $state.raw<PDFDocumentProxy>();
  let matches = $state<Array<{ page: number; local: number }>>([]);
  let findIndex = $state(0);
  let searching = $state(false);
  const textCache = new Map<number, string>();
  const term = $derived(controls?.query.trim() || '');
  const find = createViewerFind(() => pageContainer?.querySelector<HTMLElement>(`[data-page="${matches[findIndex]?.page || currentPage}"] .textLayer`), () => term);
  function step(direction: 1 | -1) {
    if (!matches.length) return;
    findIndex = (findIndex + direction + matches.length) % matches.length; goToPage(matches[findIndex].page);
  }
  $effect(() => {
    const hit = matches[findIndex];
    if (hit && find.state.matches) find.select(hit.local, true);
  });
  $effect(() => {
    const pdf = searchDocument, needle = term;
    let live = true;
    matches = []; findIndex = 0; searching = !!pdf && !!needle;
    const timer = setTimeout(() => { void (async () => {
      if (!pdf || !needle) return;
      const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      const found: Array<{ page: number; local: number }> = [];
      try {
        for (let number = 1; number <= pdf.numPages; number++) {
          if (!live) return;
          let text = textCache.get(number);
          if (text === undefined) {
            const page = await pdf.getPage(number), content = await page.getTextContent();
            if (!live) return;
            text = pdfTextLines(content.items.flatMap((item) => 'str' in item ? [{ str: item.str, transform: item.transform, width: item.width }] : [])).join('\n');
            textCache.set(number, text);
          }
          let local = 0;
          for (const _hit of text.matchAll(expression)) found.push({ page: number, local: local++ });
        }
        if (live) { matches = found; if (found.length) goToPage(found[0].page); }
      } catch { /* A search failure does not prevent reading the PDF. */ }
      finally { if (live) searching = false; }
    })(); }, 150);
    return () => { live = false; clearTimeout(timer); };
  });
  let frame = 0;
  let layoutRevision = 0;
  const scale = (page: PdfPageSize) => manualZoom ?? Math.max(0.05, (width - 24) / page.width);

  registerViewerControls(controls, () => ({
    page: currentPage, pages: pages.length, goToPage,
    zoom: manualZoom === null ? $t('viewer.fitShort') : `${Math.round(manualZoom * 100)}%`,
    zoomBy: direction => changeZoom((manualZoom ?? scale(pages[currentPage - 1] ?? { width: 612, height: 792, pageNumber: 1 })) + direction * 0.1),
    fit: () => changeZoom(null), retry: error ? () => { revision += 1; } : undefined,
    search: { matches: matches.length, index: findIndex, step, loading: searching }
  }));

  $effect(() => {
    const source = src;
    revision;
    let live = true;
    let task: PDFDocumentLoadingTask | undefined;
    let ownedRenderer: PdfRenderer | undefined;
    loading = true;
    error = null;
    pages = [];
    currentPage = 1;
    manualZoom = null;
    renderer = undefined;
    searchDocument = undefined; textCache.clear();
    async function load() {
      try {
        const pdfjs = await import('pdfjs-dist');
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
        if (!live) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const bytes = await readArrayBuffer(source, 'PDF');
        if (!live) return;
        if (!bytes.byteLength) throw new Error('PDF file is empty');
        task = pdfjs.getDocument({ data: bytes });
        const document = await task.promise;
        if (!live) return;
        searchDocument = document;
        const sizes: PdfPageSize[] = [];
        for (let number = 1; number <= document.numPages; number += 1) {
          const page = await document.getPage(number);
          if (!live) return;
          const viewport = page.getViewport({ scale: 1 });
          sizes.push({ pageNumber: number, width: viewport.width, height: viewport.height });
        }
        ownedRenderer = new PdfRenderer(document, options => new pdfjs.TextLayer(options), failure => {
          if (live) error = failure instanceof Error ? failure.message : $t('viewer.doc.failed');
        });
        renderer = ownedRenderer;
        pages = sizes;
      } catch (failure) {
        if (live) error = failure instanceof Error ? failure.message : $t('viewer.doc.failed');
      } finally {
        if (live) loading = false;
      }
    }
    void load();
    return () => {
      live = false;
      layoutRevision += 1;
      cancelAnimationFrame(frame);
      ownedRenderer?.dispose();
      void task?.destroy().catch(() => {});
    };
  });

  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(updateViewport);
  }
  function updateViewport() {
    if (!pageContainer || !renderer || !pages.length || error) return;
    const offset = pageContainer.scrollTop;
    currentPage = pageAtOffset(pages, scale, offset + Math.min(120, pageContainer.clientHeight / 3)).page;
    const buffer = pageContainer.clientHeight * 0.5;
    let top = 12;
    const visible: Array<{ pageNumber: number; scale: number }> = [];
    for (const page of pages) {
      const size = page.height * scale(page);
      if (top + size >= offset - buffer && top <= offset + pageContainer.clientHeight + buffer) visible.push({ pageNumber: page.pageNumber, scale: scale(page) });
      top += size + 14;
    }
    // Render what is being read before the buffer above it.
    visible.sort((a, b) => Math.abs(a.pageNumber - currentPage) - Math.abs(b.pageNumber - currentPage));
    renderer.viewport(visible);
  }

  /** Keep the same point on the same page, independent of other page sizes. */
  async function reflow(apply: () => void) {
    const node = pageContainer;
    const version = ++layoutRevision;
    const y = Math.min(120, (node?.clientHeight ?? 0) / 3);
    const anchor = pageAtOffset(pages, scale, (node?.scrollTop ?? 0) + y);
    const horizontal = node ? (node.scrollLeft + node.clientWidth / 2) / Math.max(1, node.scrollWidth) : 0.5;
    apply();
    await tick();
    if (version !== layoutRevision || node !== pageContainer || !node) return;
    node.scrollTop = Math.max(0, pageOffset(pages, scale, anchor.page, anchor.fraction) - y);
    node.scrollLeft = Math.max(0, horizontal * node.scrollWidth - node.clientWidth / 2);
    updateViewport();
  }
  function changeZoom(next: number | null) {
    void reflow(() => { manualZoom = next === null ? null : Math.max(0.1, Math.min(4, Math.round(next * 100) / 100)); });
  }
  function goToPage(page: number) {
    if (!pageContainer || !Number.isInteger(page) || page < 1 || page > pages.length) return;
    currentPage = page;
    pageContainer.scrollTo({ top: Math.max(0, pageOffset(pages, scale, page) - 12), behavior: readerScrollBehavior() });
    schedule();
  }
  function mount(node: HTMLDivElement, page: number) {
    const owned = renderer;
    const remove = owned?.mount(page, { canvas: node.querySelector('canvas')!, text: node.querySelector<HTMLDivElement>('.textLayer')! });
    schedule();
    return { destroy: () => remove?.() };
  }
  $effect(() => {
    if (!pageContainer) return;
    const node = pageContainer;
    width = node.clientWidth;
    schedule();
    if (typeof ResizeObserver === 'undefined') return;
    return observeViewerSize(node, () => {
      if (node.clientWidth === width) { schedule(); return; }
      void reflow(() => { width = node.clientWidth; });
    });

  });
</script>

<div class="pdf-viewer" aria-label={filename}>
  {#if loading || error}
    <ViewerStatus {loading} {error} label={$t('viewer.doc.loading')} retry={error ? () => { revision += 1; } : undefined} />
  {:else}
    <div class="pdf-page-wrap" bind:this={pageContainer} onscroll={schedule} use:panScroll={{ onzoom: direction => changeZoom((manualZoom ?? scale(pages[currentPage - 1] ?? { width: 612, height: 792, pageNumber: 1 })) + direction * 0.1) }}>
      <div class="pdf-pages">
        {#each pages as page (page.pageNumber)}
          <div class="pdf-page" use:mount={page.pageNumber} data-page={page.pageNumber} style:width={`${page.width * scale(page)}px`} style:height={`${page.height * scale(page)}px`}>
            <canvas class="pdf-canvas"></canvas>
            <div class="textLayer" data-viewer-text aria-hidden="true"></div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .pdf-viewer { display:flex; flex:1; min-width:0; min-height:0; flex-direction:column; background:var(--muted); }
  .pdf-page-wrap { flex:1; min-height:0; overflow:auto; padding:12px; }
  .pdf-page-wrap:global(.can-pan) { cursor:grab; }
  .pdf-page-wrap:global(.is-panning) { cursor:grabbing; user-select:none; }
  .pdf-pages { display:flex; width:max-content; min-width:100%; flex-direction:column; align-items:center; gap:14px; }
  .pdf-page { position:relative; flex-shrink:0; background:white; box-shadow:0 1px 3px rgb(0 0 0 / .13); }
  .pdf-canvas { display:block; width:100%; height:100%; user-select:none; }
  .textLayer { position:absolute; inset:0; overflow:clip; text-align:initial; line-height:1; text-size-adjust:none; forced-color-adjust:none; transform-origin:0 0; user-select:text; cursor:text; --min-font-size:1; --text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size)); --min-font-size-inv:calc(1 / var(--min-font-size)); }
  .textLayer :global(span), .textLayer :global(br) { position:absolute; color:transparent; white-space:pre; cursor:text; transform-origin:0 0; }
  .textLayer > :global(:not(.markedContent)), .textLayer :global(.markedContent span:not(.markedContent)) { z-index:1; --font-height:0; font-size:calc(var(--text-scale-factor) * var(--font-height)); --scale-x:1; --rotate:0deg; transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv)); }
  .textLayer :global(.markedContent) { display:contents; }
  .textLayer :global(span[role=img]) { user-select:none; cursor:default; }
  .textLayer :global(::selection) { background:color-mix(in srgb, var(--primary) 30%, transparent); }
</style>
