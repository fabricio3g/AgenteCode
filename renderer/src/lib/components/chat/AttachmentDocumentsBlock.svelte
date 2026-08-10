<svelte:options runes={true} />

<script lang="ts">
  import type { Attachment } from '$lib/types/chat';
  import DocumentSurface from './DocumentSurface.svelte';
  import { countOf } from '$lib/utils/format';
  import type { DocumentSurfaceItem } from './document-surface';

  interface Props {
    attachments?: Attachment[];
  }

  let { attachments = [] }: Props = $props();

  const readyDocs = $derived.by((): DocumentSurfaceItem[] => (attachments || [])
    .filter((attachment) => {
      if (attachment.kind === 'image') return !!(attachment.base64 || attachment.preview);
      return !!(attachment.data || attachment.preview);
    })
    .map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      title: attachment.name,
      type: attachment.type,
      size: attachment.size,
      dataUrl: attachment.kind === 'image'
        ? (attachment.base64 || attachment.preview)
        : (attachment.data || attachment.preview)
    })));
  const pendingCount = $derived((attachments || []).filter((attachment) => {
    if (attachment.status === 'error') return false;
    if (attachment.kind === 'image') return !(attachment.base64 || attachment.preview);
    return !(attachment.data || attachment.preview);
  }).length);
  const errorCount = $derived((attachments || []).filter((attachment) => attachment.status === 'error').length);
</script>

{#if readyDocs.length}
  <DocumentSurface
    docs={readyDocs}
    title={readyDocs.length > 1 ? `${readyDocs.length} attachments` : readyDocs[0].title}
    launcherMode="strip"
  />
{/if}

{#if pendingCount}
  <div class="attachment-doc-note">
    {countOf(pendingCount, 'attachment')} still preparing
  </div>
{/if}

{#if errorCount}
  <div class="attachment-doc-note">
    {countOf(errorCount, 'attachment')} could not be previewed
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
