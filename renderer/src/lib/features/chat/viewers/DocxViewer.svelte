<svelte:options runes={true} />

<!--
  A Word document the way Word shows it: real pages (docx-preview renders the
  file's own geometry, fonts, headers, footers and footnotes) as white sheets
  on a gray canvas. Along the bottom, like Word's status bar: the page you're
  on, find in document, zoom and fit-to-width.

  Pages stay white in dark mode, as in Word: the document's own colors are
  written for paper.
-->

<script lang="ts">
  import { ChevronDown, ChevronUp, Minus, Plus, Search, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import ViewerStatus from './ViewerStatus.svelte';
  import { fitZoom, loadDocxInto } from './docx-pages';
  import { panScroll, zoomAroundCenter } from './pan-scroll';
  import { tick } from 'svelte';

  interface Props {
    src: string;
    filename: string;
    /** Find text, e.g. from the reader's search box. */
    query?: string;
  }

  let { src, filename, query = '' }: Props = $props();

  const HIGHLIGHT = 'docx-find';
  const HIGHLIGHT_ACTIVE = 'docx-find-active';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let pageCount = $state(0);
  let page = $state(1);
  /** null = fit to width (follows the panel as it resizes). */
  let manualZoom = $state<number | null>(null);
  let fit = $state(1);
  let find = $state('');
  let findIndex = $state(0);
  let hits = $state<Range[]>([]);
  let host: HTMLDivElement | undefined = $state();
  let canvas: HTMLDivElement | undefined = $state();

  const zoom = $derived(manualZoom ?? fit);
  const term = $derived((find || query).trim());

  async function render(source: string, name: string, target: HTMLDivElement, isCurrent: () => boolean) {
    loading = true;
    error = null;
    pageCount = 0;
    target.replaceChildren();
    try {
      if (!source) throw new Error($t('viewer.doc.failed'));
      // Each load owns its target, so a superseded render can't land late.
      const pending = document.createElement('div');
      const pages = await loadDocxInto(source, name, pending);
      if (!isCurrent()) return;
      target.replaceChildren(...pending.childNodes);
      pageCount = pages;
      page = 1;
      recalcFit();
    } catch (err) {
      console.error('[DocxViewer] Failed to render DOCX:', err);
      if (isCurrent()) error = $t('viewer.doc.failed');
    } finally {
      if (isCurrent()) loading = false;
    }
  }

  function pages(): HTMLElement[] {
    return Array.from(host?.querySelectorAll<HTMLElement>('section.docx') ?? []);
  }

  function recalcFit() {
    const first = pages()[0];
    const available = (canvas?.clientWidth || 0) - 48;
    fit = first ? fitZoom(first.offsetWidth, available) : 1;
  }

  $effect(() => {
    if (!host) return;
    let current = true;
    void render(src, filename, host, () => current);
    return () => {
      current = false;
    };
  });

  $effect(() => {
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => recalcFit());
    observer.observe(canvas);
    return () => observer.disconnect();
  });

  /** Which page sits under the middle of the canvas. */
  function trackPage() {
    if (!canvas) return;
    const middle = canvas.getBoundingClientRect().top + canvas.clientHeight / 3;
    const list = pages();
    let current = 1;
    list.forEach((section, index) => {
      if (section.getBoundingClientRect().top <= middle) current = index + 1;
    });
    page = current;
  }

  function goToPage(next: number) {
    const target = pages()[Math.max(0, Math.min(pageCount - 1, next - 1))];
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function setZoom(next: number | null) {
    const value = next === null ? null : Math.max(0.3, Math.min(3, Math.round(next * 10) / 10));
    void zoomAroundCenter(canvas, () => (manualZoom = value), tick);
  }

  // Find: collect a Range per hit and paint them with the CSS Highlight API.
  $effect(() => {
    const needle = term.toLowerCase();
    const registry = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
    registry?.delete(HIGHLIGHT);
    registry?.delete(HIGHLIGHT_ACTIVE);
    if (!host || loading || !needle) {
      hits = [];
      return;
    }
    const found: Range[] = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent || '').toLowerCase();
      let at = text.indexOf(needle);
      while (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        found.push(range);
        at = text.indexOf(needle, at + needle.length);
      }
    }
    hits = found;
    findIndex = 0;
    if (registry && found.length) registry.set(HIGHLIGHT, new Highlight(...found));
    showHit(0);
  });

  function showHit(index: number) {
    const range = hits[index];
    if (!range) return;
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(range));
    range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function step(direction: 1 | -1) {
    if (!hits.length) return;
    findIndex = (findIndex + direction + hits.length) % hits.length;
    showHit(findIndex);
  }

  $effect(() => () => {
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
      CSS.highlights.delete(HIGHLIGHT);
      CSS.highlights.delete(HIGHLIGHT_ACTIVE);
    }
  });
</script>

<div class="docx-viewer">
  <div class="docx-canvas" bind:this={canvas} onscroll={trackPage} use:panScroll={{ onzoom: (dir) => setZoom(zoom + dir * 0.1) }}>
    {#if loading || error}
      <div class="docx-status">
        <ViewerStatus {loading} {error} label={$t('viewer.doc.loading')} variant="card" errorTitle={$t('viewer.doc.failed')} />
      </div>
    {/if}
    <!-- CSS zoom (not a transform) so the scroll height follows the zoom. -->
    <div class="docx-pages" class:pending={loading || !!error} style:zoom={zoom}>
      <div class="docx-host" bind:this={host}></div>
    </div>
  </div>

  {#if !loading && !error}
    <div class="docx-bar">
      <div class="page-nav">
        <button type="button" class="bar-btn" onclick={() => goToPage(page - 1)} disabled={page <= 1} aria-label={$t('viewer.previous')}><ChevronUp class="size-3.5" /></button>
        <span class="page-label">{$t('viewer.page', { values: { n: page, total: pageCount } })}</span>
        <button type="button" class="bar-btn" onclick={() => goToPage(page + 1)} disabled={page >= pageCount} aria-label={$t('viewer.next')}><ChevronDown class="size-3.5" /></button>
      </div>

      <label class="find">
        <Search class="size-3.5 shrink-0 opacity-60" />
        <input
          bind:value={find}
          placeholder={$t('artifacts.reader.search')}
          aria-label={$t('artifacts.reader.search')}
          onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }}
        />
        {#if term}
          <span class="find-count">{hits.length ? `${findIndex + 1}/${hits.length}` : '0'}</span>
          <button type="button" class="bar-btn" onclick={() => step(-1)} aria-label={$t('viewer.previous')}><ChevronUp class="size-3.5" /></button>
          <button type="button" class="bar-btn" onclick={() => step(1)} aria-label={$t('viewer.next')}><ChevronDown class="size-3.5" /></button>
          {#if find}<button type="button" class="bar-btn" onclick={() => (find = '')} aria-label={$t('artifacts.clearSearch')}><X class="size-3.5" /></button>{/if}
        {/if}
      </label>

      <div class="zoom">
        <button type="button" class="fit-btn" class:on={manualZoom === null} onclick={() => setZoom(null)}>{$t('viewer.fit')}</button>
        <button type="button" class="bar-btn" onclick={() => setZoom(zoom - 0.1)} aria-label={$t('viewer.zoomOut')}><Minus class="size-3.5" /></button>
        <button type="button" class="zoom-value" onclick={() => setZoom(1)} title={$t('viewer.zoomReset')}>{Math.round(zoom * 100)}%</button>
        <button type="button" class="bar-btn" onclick={() => setZoom(zoom + 0.1)} aria-label={$t('viewer.zoomIn')}><Plus class="size-3.5" /></button>
      </div>
    </div>
  {/if}
</div>

<style>
  .docx-viewer {
    --docx-canvas: color-mix(in srgb, var(--foreground) 7%, var(--background));
    display: flex;
    height: var(--doc-viewer-height, calc(96vh - 8rem));
    min-height: 16rem;
    flex: 1 1 auto;
    flex-direction: column;
    overflow: hidden;
    border: var(--doc-viewer-border, 1px solid var(--border));
    border-radius: var(--doc-viewer-radius, 0.75rem);
    background: var(--docx-canvas);
  }

  .docx-canvas {
    position: relative;
    min-height: 0;
    flex: 1;
    overflow: auto;
    padding: 1.5rem 1.5rem 2rem;
  }
  /* Zoomed wider than the view: drag to move around. */
  .docx-canvas:global(.can-pan) {
    cursor: grab;
  }
  .docx-canvas:global(.is-panning) {
    cursor: grabbing;
    user-select: none;
  }
  .docx-status {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .docx-pages {
    width: fit-content;
    margin: 0 auto;
  }
  .docx-pages.pending {
    visibility: hidden;
  }

  .docx-bar {
    display: flex;
    height: 2.25rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0 0.5rem;
    border-top: 1px solid var(--border);
    background: var(--background);
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .page-nav,
  .zoom {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }
  .page-label {
    min-width: 6.5rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .find {
    display: flex;
    min-width: 0;
    max-width: 16rem;
    flex: 1;
    height: 1.625rem;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.25rem 0 0.5rem;
    border-radius: 9999px;
    background: var(--muted);
  }
  .find input {
    min-width: 0;
    flex: 1;
    border: 0;
    background: transparent;
    font-size: 12px;
    color: var(--foreground);
    outline: none;
  }
  .find-count {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .bar-btn {
    display: inline-flex;
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    color: var(--muted-foreground);
  }
  .bar-btn:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  .bar-btn:disabled {
    opacity: 0.4;
  }
  .fit-btn {
    height: 1.5rem;
    padding: 0 0.5rem;
    border-radius: 0.375rem;
    font-size: 11.5px;
  }
  .fit-btn:hover,
  .fit-btn.on {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  .zoom-value {
    min-width: 2.75rem;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }

  /* Pages: white sheets with a soft paper shadow, spaced like Word. */
  :global(.docx-viewer .docx-wrapper) {
    background: transparent !important;
    padding: 0 !important;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
  }
  :global(.docx-viewer .docx-wrapper > section.docx) {
    margin: 0 !important;
    background: #fff;
    color: #1b1b1f;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.12), 0 4px 16px rgb(0 0 0 / 0.08) !important;
  }
  :global(::highlight(docx-find)) {
    background-color: rgb(255 214 10 / 0.55);
    color: inherit;
  }
  :global(::highlight(docx-find-active)) {
    background-color: rgb(255 150 0 / 0.85);
    color: #000;
  }
</style>
