<svelte:options runes={true} />

<script lang="ts">
  import type { Attachment } from '$lib/types/chat';
  import DocumentSurface from './DocumentSurface.svelte';
  import type { DocumentSurfaceItem } from './document-surface';

  interface Props {
    attachments?: Attachment[];
  }

  let { attachments = [] }: Props = $props();

  const documents = $derived((attachments || []).filter((attachment) => attachment.kind !== 'image'));
  const readyDocs = $derived.by((): DocumentSurfaceItem[] => documents
    .filter((attachment) => !!attachment.data)
    .map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      title: attachment.name,
      type: attachment.type,
      size: attachment.size,
      dataUrl: attachment.data
    })));
  const pendingCount = $derived(documents.filter((attachment) => !attachment.data).length);
</script>

{#if readyDocs.length}
  <DocumentSurface
    docs={readyDocs}
    title={readyDocs.length > 1 ? `${readyDocs.length} attachments` : readyDocs[0].title}
  />
{/if}

{#if pendingCount}
  <div class="attachment-doc-note">
    {pendingCount} document{pendingCount !== 1 ? 's' : ''} still preparing
  </div>
{/if}

<style>
  .attachment-doc-note {
    flex-basis: 100%;
    color: var(--text-muted);
    font-size: 0.7rem;
    text-align: right;
  }
</style>
