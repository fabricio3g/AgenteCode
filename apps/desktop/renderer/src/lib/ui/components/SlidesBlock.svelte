<script lang="ts">
  import type { ChatMessage } from '$lib/types/chat';
  import DocumentSurface from '$lib/features/chat/DocumentSurface.svelte';
  import type { DocumentSurfaceItem } from '$lib/features/chat/document-surface';

  interface Props {
    slides?: ChatMessage['slides'];
    mode?: ChatMessage['mode'];
    onDownload: () => void;
  }

  let { slides = [], onDownload }: Props = $props();

  const docs = $derived.by((): DocumentSurfaceItem[] => {
    if (!slides?.length) return [];
    return [{
      id: 'slides',
      name: 'presentation.pptx',
      title: 'Presentation ready',
      kind: 'slides',
      slides
    }];
  });
</script>

{#if docs.length}
  <DocumentSurface
    docs={docs}
    title="Presentation ready"
    onDownloadSlides={onDownload}
  />
{/if}
