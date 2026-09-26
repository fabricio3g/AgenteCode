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
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import { parseContentSegments } from '$lib/utils/charts';
  import ChartBlock from './ChartBlock.svelte';
  import PdfViewer from './viewers/PdfViewer.svelte';
  import DocxViewer from './viewers/DocxViewer.svelte';
  import XlsxViewer from './viewers/XlsxViewer.svelte';
  import TextViewer from './viewers/TextViewer.svelte';
  import SlidesViewer from './SlidesViewer.svelte';
  import PptxViewer from './viewers/PptxViewer.svelte';
  import { baseName, type DocumentSurfaceItem } from './document-surface';
  import { downloadFromDataUrl } from '$lib/utils/doc-utils';
  import { documentSource, pickDocumentViewer } from './document-viewer';

  interface Props {
    doc: DocumentSurfaceItem;
    /** Highlighted in markdown, text and sheets. */
    query?: string;
    onDownloadSlides?: () => void;
  }

  let { doc, query = '', onDownloadSlides }: Props = $props();

  let root = $state<HTMLElement>();
  const viewer = $derived(pickDocumentViewer(doc));
  const source = $derived(documentSource(doc));
  const term = $derived(query.trim());
  const previewHtml = $derived(viewer === 'html' && doc.previewHtml ? buildPreviewHtml(doc.previewHtml, {}, doc.name).html : '');

  function downloadFile() {
    if (source) downloadFromDataUrl(source, baseName(doc.name));
  }

  function markdownHtml(content: string): string {
    const html = renderMarkdown(content || '');
    if (!term) return html;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
  }

  // Bring the first search hit into view.
  $effect(() => {
    if (!term || !root || viewer !== 'markdown') return;
    requestAnimationFrame(() => root?.querySelector('mark')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  });
</script>

<div class="doc-viewer" bind:this={root}>
  {#if viewer === 'pptx'}
    <PptxViewer src={source} filename={doc.name} spec={doc.deck} />
  {:else if viewer === 'slides' && doc.slides}
    <SlidesViewer slides={doc.slides} onDownload={onDownloadSlides || downloadFile} />
  {:else if viewer === 'pdf'}
    <PdfViewer src={source} filename={doc.name} />
  {:else if viewer === 'docx'}
    <DocxViewer src={source} filename={doc.name} {query} />
  {:else if viewer === 'xlsx'}
    <XlsxViewer src={source} filename={doc.name} {query} />
  {:else if viewer === 'markdown'}
    <article class="doc-article">
      {#each parseContentSegments(doc.content || '') as segment, index (index)}
        {#if segment.kind === 'text'}
          {#if segment.content.trim()}
            <div class="markdown-body mb-3">{@html markdownHtml(segment.content)}</div>
          {/if}
        {:else}
          <ChartBlock type={segment.type} title={segment.title} xlabel={segment.xlabel} ylabel={segment.ylabel} raw={segment.raw} />
        {/if}
      {/each}
    </article>
  {:else if viewer === 'text'}
    <TextViewer src={source} filename={doc.name} {query} />
  {:else if viewer === 'image'}
    <div class="doc-image-stage">
      <img class="doc-image" src={source} alt={doc.title || baseName(doc.name)} />
    </div>
  {:else if viewer === 'html'}
    <iframe class="doc-iframe" srcdoc={previewHtml} sandbox="" referrerpolicy="no-referrer" title={doc.title || baseName(doc.name)}></iframe>
  {:else if viewer === 'pptx-missing'}
    <div class="doc-empty"><Files class="size-5" /><span>{$t('artifacts.viewer.pptxMissing')}</span></div>
  {:else}
    <div class="doc-empty">{$t('artifacts.viewer.unsupported')}</div>
  {/if}
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
  .doc-article {
    width: min(48rem, 100%);
    margin: 0 auto;
    padding: 1.5rem 0.5rem 2.5rem;
    color: var(--text);
    font-size: 0.95rem;
    line-height: 1.68;
  }
  .doc-iframe {
    display: block;
    width: 100%;
    min-height: 20rem;
    flex: 1 1 auto;
    height: var(--doc-viewer-height, calc(96vh - 7.5rem));
    border: 0;
    border-radius: 0.5rem;
    background: var(--card);
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
    align-items: center;
    justify-content: center;
    gap: 0.55rem;
    padding: 1rem;
    text-align: center;
    color: var(--muted-foreground);
    font-size: 13px;
  }
</style>
