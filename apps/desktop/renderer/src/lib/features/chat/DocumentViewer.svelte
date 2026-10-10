<svelte:options runes={true} />

<!--
  Draws one document with its native viewer (see `pickDocumentViewer`).
  Used by the chat reader and by the Artifacts studio, so both show the
  same thing for the same file.
-->

<script lang="ts">
  import { Files } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { renderMarkdown } from '$lib/utils/markdown';
  import HtmlViewer from './viewers/HtmlViewer.svelte';
  import { parseContentSegments } from '$lib/utils/charts';
  import ChartBlock from './ChartBlock.svelte';
  import PdfViewer from './viewers/PdfViewer.svelte';
  import DocxViewer from './viewers/DocxViewer.svelte';
  import XlsxViewer from './viewers/XlsxViewer.svelte';
  import TextViewer from './viewers/TextViewer.svelte';
  import SlidesViewer from './SlidesViewer.svelte';
  import PptxViewer from './viewers/PptxViewer.svelte';
  import { baseName, type DocumentSurfaceItem } from './document-surface';
  import { downloadFromDataUrl, downloadFromSrc } from '$lib/utils/doc-utils';
  import { documentSource, pickDocumentViewer } from './document-viewer';

  import { createViewerFind } from './viewers/viewer-find.svelte';
  import ViewerToolbar from './viewers/ViewerToolbar.svelte';
  import { createViewerControls, provideViewerControls, registerViewerControls, useViewerControls, viewerShortcuts } from './viewers/viewer-controls.svelte';

  interface Props {
    doc: DocumentSurfaceItem;
    /** Highlighted in markdown, text and sheets. */
    query?: string;
    onDownloadSlides?: () => void;
  }

  let { doc, query = '', onDownloadSlides }: Props = $props();

  const inherited = useViewerControls();
  const controls = inherited ?? createViewerControls();
  provideViewerControls(controls);
  $effect(() => { doc.id; controls.query = query; controls.searchOpen = !!query; });
  $effect(() => {
    doc;
    controls.download = downloadFile;
    return () => { if (controls.download === downloadFile) controls.download = null; };
  });

  let root = $state<HTMLElement>();
  const viewer = $derived(pickDocumentViewer(doc));
  const source = $derived(documentSource(doc));
  const term = $derived(controls.query.trim());
  const effectiveQuery = $derived(controls.query);
  let article = $state<HTMLElement>();
  const find = createViewerFind(() => article, () => viewer === 'markdown' ? term : '');
  registerViewerControls(controls, () => viewer === 'markdown' ? {
    search: { matches: find.state.matches, index: find.state.index, step: find.step }
  } : null);

  function downloadFile() {
    if (doc.kind === 'slides' && onDownloadSlides) { onDownloadSlides(); return; }
    if (!source) return;
    if (source.startsWith('data:')) downloadFromDataUrl(source, baseName(doc.name));
    else downloadFromSrc(source, baseName(doc.name));
  }

  function markdownHtml(content: string): string { return renderMarkdown(content || ''); }
</script>

<div class="doc-viewer" bind:this={root} use:viewerShortcuts={controls}>
  {#if !inherited && viewer !== 'image'}<ViewerToolbar title={doc.title || baseName(doc.name)} ondownload={downloadFile} />{/if}
  {#key doc.id}
  {#if viewer === 'pptx'}
    <PptxViewer src={source} filename={doc.name} spec={doc.deck} />
  {:else if viewer === 'slides' && doc.slides}
    <SlidesViewer slides={doc.slides} onDownload={onDownloadSlides || downloadFile} />
  {:else if viewer === 'pdf'}
    <PdfViewer src={source} filename={doc.name} />
  {:else if viewer === 'docx'}
    <DocxViewer src={source} filename={doc.name} query={effectiveQuery} />
  {:else if viewer === 'xlsx'}
    <XlsxViewer src={source} filename={doc.name} query={effectiveQuery} />
  {:else if viewer === 'markdown'}
    <div class="doc-reading"><article class="doc-article" bind:this={article} data-viewer-text>
      {#each parseContentSegments(doc.content || '') as segment, index (index)}
        {#if segment.kind === 'text'}
          {#if segment.content.trim()}
            <div class="markdown-body mb-3">{@html markdownHtml(segment.content)}</div>
          {/if}
        {:else}
          <ChartBlock type={segment.type} title={segment.title} xlabel={segment.xlabel} ylabel={segment.ylabel} raw={segment.raw} />
        {/if}
      {/each}
    </article></div>
  {:else if viewer === 'text'}
    <TextViewer src={source} filename={doc.name} query={effectiveQuery} />
  {:else if viewer === 'image'}
    <div class="doc-image-stage">
      <img class="doc-image" src={source} alt={doc.title || baseName(doc.name)} />
    </div>
  {:else if viewer === 'html'}
    <HtmlViewer html={doc.previewHtml || doc.content || ''} src={source} filename={doc.name} />
  {:else if viewer === 'pptx-missing'}
    <div class="doc-empty"><Files class="size-5" /><span>{$t('artifacts.viewer.pptxMissing')}</span></div>
  {:else}
    <div class="doc-empty">{$t('artifacts.viewer.unsupported')}</div>
  {/if}
  {/key}
</div>

<style>
  .doc-viewer {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
  }
  .doc-viewer :global(mark) {
    border-radius: 2px;
    background: color-mix(in srgb, var(--primary) 22%, transparent);
    color: inherit;
    padding: 0 0.08rem;
  }
  .doc-reading { min-height:0; flex:1; overflow:auto; }
  .doc-article :global(h1), .doc-article :global(h2), .doc-article :global(h3),
  .doc-article :global(h4), .doc-article :global(h5), .doc-article :global(h6) { color:var(--foreground) !important; }
  .doc-article {
    width: min(48rem, 100%);
    margin: 0 auto;
    padding: 1.5rem 0.5rem 2.5rem;
    color: var(--text);
    font-size: var(--text-prose);
    line-height: 1.68;
  }
  .doc-image-stage {
    display: flex;
    min-height: 18rem;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
  }
  .doc-image {
    display: block;
    max-width: 100%;
    max-height: calc(96vh - 10rem);
    object-fit: contain;
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-sm);
  }
  .doc-empty {
    display: flex;
    min-height: 18rem;
    align-items: flex-start;
    gap: 0.55rem;
    padding: 1rem;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
  }
</style>
