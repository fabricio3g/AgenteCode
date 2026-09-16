<svelte:options runes={true} />

<!--
  DOCX viewer — real pages, not a styled text column.

  Mammoth gave semantic HTML plus a hand-written stylesheet inside a fixed-height
  iframe: one endless column of body text, hardcoded light colors (a glare in dark
  mode), and a large white void beneath short documents. The document's own page
  geometry, headers, footers and fonts were all discarded.

  `docx-preview` (Apache-2.0) renders the DOCX itself: real A4 pages, page breaks
  from the file, headers/footers/footnotes, and document width/height. The stock
  gray backdrop is replaced with the app's muted canvas, and pages are scaled down
  (never up) to fit the reader column so a portrait page is fully visible on a
  laptop screen — the same anatomy Google Docs and Word's web viewer use.

  The pipeline itself lives in docx-pages.ts (loading, page counting, zoom math)
  so this file stays a template over tested logic.
-->

<script lang="ts">
  import { copy } from '$lib/copy';
  import ViewerStatus from './ViewerStatus.svelte';
  import { fitZoom, loadDocxInto } from './docx-pages';

  interface Props {
    src: string;
    filename: string;
  }

  let { src, filename }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let pageCount = $state(0);
  let zoom = $state(1);
  let host: HTMLDivElement | undefined = $state();
  let stage: HTMLDivElement | undefined = $state();

  async function renderDocx(source: string, isCurrent: () => boolean) {
    loading = true;
    error = null;
    pageCount = 0;
    if (!source || !host) return;
    try {
      const pages = await loadDocxInto(source, filename, host);
      if (!isCurrent()) return;
      pageCount = pages;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (isCurrent()) recalcZoom();
    } catch (err) {
      console.error('[DocxViewer] Failed to render DOCX:', err);
      if (isCurrent()) {
        error = err instanceof Error ? err.message : 'Document preview is unavailable. Download it to open.';
      }
    } finally {
      if (isCurrent()) loading = false;
    }
  }

  function recalcZoom() {
    const page = host?.querySelector<HTMLElement>('section.docx');
    const available = (stage?.clientWidth || 0) - 40;
    zoom = page ? fitZoom(page.offsetWidth, available) : 1;
  }

  $effect(() => {
    let current = true;
    void renderDocx(src, () => current);
    return () => {
      current = false;
    };
  });

  $effect(() => {
    if (!stage) return;
    const observer = new ResizeObserver(() => recalcZoom());
    observer.observe(stage);
    return () => observer.disconnect();
  });
</script>

<div class="docx-viewer" class:centered={loading || !!error}>
  {#if loading || error}
    <ViewerStatus
      {loading}
      {error}
      label={copy.viewer.convertingDocument}
      variant="card"
      errorTitle={copy.viewer.previewUnavailable}
    />
  {:else}
    <div class="docx-stage" bind:this={stage}>
      <!--
        Pages render at their fixed A4 pixel width inside the host. The stage
        scales the whole stack to the column instead (origin top center), so a
        portrait page is fully visible without horizontal scrolling.
      -->
      <div class="docx-zoom" style={`--docx-zoom: ${zoom}`}>
        <div class="docx-host" bind:this={host}></div>
      </div>
    </div>
    {#if pageCount}
      <div class="docx-meta">{pageCount === 1 ? '1 page' : `${pageCount} pages`}</div>
    {/if}
  {/if}
</div>

<style>
  .docx-viewer {
    display: flex;
    min-height: 100%;
    flex-direction: column;
  }

  .docx-viewer.centered {
    align-items: center;
    justify-content: center;
  }

  /*
   * Muted canvas; the pages themselves are the content. The parent supplies
   * the scrolling, so this only centers the column.
   *
   * display:block, not flex: in a flex row a fixed-width page would shrink to
   * the column before the scale transform is ever applied, distorting the
   * geometry the viewer measures for fitZoom. As a block child the page keeps
   * its real width, and the transform-origin centers the scaled stack.
   */
  .docx-stage {
    display: block;
    width: 100%;
    padding: 0.75rem 0 1.5rem;
  }

  .docx-zoom {
    transform: scale(var(--docx-zoom, 1));
    transform-origin: top center;
    will-change: transform;
    width: fit-content;
    margin: 0 auto;
  }

  .docx-meta {
    padding: 0 0 0.85rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.7rem;
  }

  /* The library's stock gray backdrop and card shadows are replaced with the
     app surface, so pages sit on our canvas like PDF pages do. */
  :global(.docx-viewer .docx-wrapper) {
    background: transparent;
    padding: 0;
  }

  :global(.docx-viewer .docx-wrapper > section.docx) {
    box-shadow: none;
    margin-bottom: 0.9rem;
    border-radius: 4px;
  }

  :global(.docx-viewer .docx-wrapper > section.docx:last-child) {
    margin-bottom: 0;
  }
</style>
