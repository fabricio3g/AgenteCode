<svelte:options runes={true} />

<!--
  A Word document the way Word shows it: real pages (docx-preview renders the
  file's own geometry, fonts, headers, footers and footnotes) as white sheets
  on a quiet canvas. Reading controls belong to the shared toolbar.

  Pages stay white in dark mode, as in Word: the document's own colors are
  written for paper.
-->

<script lang="ts">
  import { observeViewerSize } from './viewer-layout';
  import { t } from 'svelte-i18n';
  import ViewerStatus from './ViewerStatus.svelte';
  import { fitZoom, loadDocxInto } from './docx-pages';
  import { panScroll, zoomAroundCenter } from './pan-scroll';
  import { createViewerFind } from './viewer-find.svelte';
  import { tick } from 'svelte';
  import { registerViewerControls, useViewerControls } from './viewer-controls.svelte';
  import { readerScrollBehavior } from './pan-scroll';
  import INTER_FONT from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';

  interface Props {
    src: string;
    filename: string;
    /** Find text, e.g. from the reader's search box. */
    query?: string;
  }

  let { src, filename, query = '' }: Props = $props();

  const controls = useViewerControls();
  let revision = $state(0);

  let loading = $state(true);
  let error = $state<string | null>(null);
  let pageCount = $state(0);
  let page = $state(1);
  /** null = fit to width (follows the panel as it resizes). */
  let manualZoom = $state<number | null>(null);
  let fit = $state(1);

  let host: HTMLDivElement | undefined = $state();
  let canvas: HTMLDivElement | undefined = $state();

  const zoom = $derived(manualZoom ?? fit);
  const term = $derived((query || controls?.query || '').trim());
  const find = createViewerFind(() => loading ? null : host, () => term);
  registerViewerControls(controls, () => ({
    page, pages: pageCount, goToPage, zoom: manualZoom === null ? $t('viewer.fitShort') : `${Math.round(zoom * 100)}%`,
    zoomBy: direction => setZoom(zoom + direction * 0.1), fit: () => setZoom(null),
    search: { matches: find.state.matches, index: find.state.index, step: find.step },
    retry: error ? () => { revision += 1; } : undefined
  }));

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
    revision;
    let current = true;
    void render(src, filename, host, () => current);
    return () => {
      current = false;
    };
  });

  $effect(() => {
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    return observeViewerSize(canvas, recalcFit);
  });

  $effect(() => {
    if (typeof FontFace === 'undefined' || !document.fonts) return;
    // Exported documents call the bundled typeface Inter; the app's ladder
    // uses Inter Variable. Supply the alias without overriding uploaded fonts.
    const font = new FontFace('Inter', `url(${INTER_FONT})`, { weight: '100 900' });
    document.fonts.add(font);
    void font.load().catch(() => {});
    return () => { document.fonts.delete(font); };
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
    target?.scrollIntoView({ block: 'start', behavior: readerScrollBehavior() });
  }

  function setZoom(next: number | null) {
    const value = next === null ? null : Math.max(0.3, Math.min(3, Math.round(next * 10) / 10));
    void zoomAroundCenter(canvas, () => (manualZoom = value), tick);
  }

</script>

<div class="docx-viewer">
  <div class="docx-canvas" bind:this={canvas} onscroll={trackPage} use:panScroll={{ onzoom: (dir) => setZoom(zoom + dir * 0.1) }}>
    {#if loading || error}
      <div class="docx-status">
        <ViewerStatus {loading} {error} label={$t('viewer.doc.loading')} variant="card" errorTitle={$t('viewer.doc.failed')} retry={error ? () => { revision += 1; } : undefined} />
      </div>
    {/if}
    <!-- CSS zoom (not a transform) so the scroll height follows the zoom. -->
    <div class="docx-pages" class:pending={loading || !!error} style:zoom={zoom}>
      <div class="docx-host" data-viewer-text bind:this={host}></div>
    </div>
  </div>


</div>

<style>
  .docx-viewer {
    --docx-canvas: color-mix(in srgb, var(--foreground) 7%, var(--background));
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    overflow: hidden;

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
</style>
