<svelte:options runes={true} />

<script lang="ts">
  import { getViewerKind, downloadFromSrc, type ViewerKind } from '$lib/utils/doc-utils';
  import DocumentCard from './DocumentCard.svelte';
  import PdfViewer from './viewers/PdfViewer.svelte';
  import DocxViewer from './viewers/DocxViewer.svelte';
  import XlsxViewer from './viewers/XlsxViewer.svelte';
  import TextViewer from './viewers/TextViewer.svelte';

  interface Props {
    name: string;
    type: string;
    size: number;
    data: string;
    error?: string;
    compact?: boolean;
    defaultOpen?: boolean;
  }

  let { name, type, size, data, error = '', compact = false, defaultOpen = false }: Props = $props();

  let collapsed = $state(true);
  let lastSourceKey = $state('');

  const viewerKind = $derived(getViewerKind(name, type));

  $effect(() => {
    const sourceKey = `${name}:${data}`;
    if (sourceKey !== lastSourceKey) {
      lastSourceKey = sourceKey;
      collapsed = !defaultOpen;
    }
  });
</script>

<DocumentCard
  {name}
  {type}
  {size}
  {viewerKind}
  {collapsed}
  {compact}
  {error}
  hasData={!!data}
  onToggle={() => (collapsed = !collapsed)}
  onDownload={() => downloadFromSrc(data, name)}
>
  {#if viewerKind === 'pdf'}
    <PdfViewer src={data} filename={name} />
  {:else if viewerKind === 'docx'}
    <DocxViewer src={data} filename={name} />
  {:else if viewerKind === 'xlsx'}
    <XlsxViewer src={data} filename={name} />
  {:else if viewerKind === 'text'}
    <TextViewer src={data} filename={name} />
  {:else if viewerKind === 'image'}
    <img src={data} alt={name} class="doc-image" />
  {:else if viewerKind === 'pptx'}
    <div class="doc-unsupported">PPTX preview is not available inline. Use the download button to save the file.</div>
  {:else}
    <div class="doc-unsupported">Preview not available for this file type.</div>
  {/if}
</DocumentCard>

<style>
  .doc-image {
    max-height: 24rem;
    max-width: 100%;
    object-fit: contain;
  }

  .doc-unsupported {
    padding: 1.5rem 0;
    text-align: center;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
</style>
