<svelte:options runes={true} />

<script lang="ts">
  import { getViewerKind, downloadFromDataUrl } from '$lib/utils/doc-utils';
  import DocumentCard from './DocumentCard.svelte';

  interface Props {
    name: string;
    dataUrl: string;
    previewHtml: string;
    defaultOpen?: boolean;
  }

  let { name, dataUrl, previewHtml, defaultOpen = false }: Props = $props();

  let collapsed = $state(true);
  let lastSourceKey = $state('');

  const viewerKind = $derived(getViewerKind(name));
  const sizeBytes = $derived(dataUrl ? Math.round(dataUrl.length * 3 / 4) : 0);

  $effect(() => {
    const sourceKey = `${name}:${dataUrl}`;
    if (sourceKey !== lastSourceKey) {
      lastSourceKey = sourceKey;
      collapsed = !defaultOpen;
    }
  });
</script>

<DocumentCard
  {name}
  {viewerKind}
  size={sizeBytes}
  {collapsed}
  hasData={!!dataUrl}
  onToggle={() => (collapsed = !collapsed)}
  onDownload={() => downloadFromDataUrl(dataUrl, name)}
>
  {#if previewHtml}
    <div class="doc-frame">
      <iframe
        class="doc-iframe"
        srcdoc={previewHtml}
        sandbox="allow-scripts allow-same-origin"
        title="{name} preview"
      ></iframe>
    </div>
  {/if}
</DocumentCard>

<style>
  .doc-frame {
    overflow: hidden;
    background: var(--surface);
  }

  .doc-iframe {
    width: 100%;
    height: clamp(18rem, 48vh, 32rem);
    border: 0;
    background: #fff;
  }
</style>
