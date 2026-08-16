<svelte:options runes={true} />

<script lang="ts">
  import { X } from 'lucide-svelte';
  import { getFileIcon } from '$lib/utils/doc-utils';
  import { fileTypeLabel } from '$lib/components/chat/document-surface';
  import { formatBytes } from '$lib/utils/format';
  import { appStore } from '$lib/stores/app.svelte';
  import type { Attachment } from '$lib/types/chat';

  /**
   * The secondary line. "Ready" told the user nothing they could not already
   * see — the card only exists once the file is attached. Type and size are
   * what actually identify a file at a glance, so they take that slot and the
   * status only appears while it still means something.
   */
  function detailLine(file: Attachment): string {
    // No `kind` here: it only distinguishes report/slides, and composer
    // attachments want the plain extension label (PDF, DOCX, XLSX…).
    const parts = [fileTypeLabel(file.name)];
    const size = formatBytes(file.size, '');
    if (size) parts.push(size);
    return parts.join(' · ');
  }
</script>

{#if appStore.pendingAttachments.length > 0}
  <div class="attachment-row">
    {#each appStore.pendingAttachments as file (file.id)}
      {#if file.kind === 'image' && (file.preview || file.base64)}
        <div class="group relative">
          <img src={file.base64 || file.preview} alt={file.name} class="attachment-thumb" />
          <button
            aria-label="Remove image"
            class="remove-btn"
            type="button"
            onclick={(e) => { e.stopPropagation(); appStore.removeAttachment(file.id); }}
          >
            <X class="h-3 w-3" />
          </button>
        </div>
      {:else}
        <div class="attachment-card group relative" class:is-error={file.status === 'error'}>
          <span class="attachment-icon">
            {#if file.status === 'processing'}
              <span class="spinner"></span>
            {:else}
              {#each [getFileIcon(file.name, file.type)] as Icon}
                <Icon class="h-4 w-4" />
              {/each}
            {/if}
          </span>

          <span class="attachment-copy">
            <span class="attachment-name" title={file.name}>{file.name}</span>
            <span class="attachment-detail">
              {#if file.status === 'error'}
                <span class="text-error">{file.error || 'Could not read this file'}</span>
              {:else if file.status === 'processing'}
                Reading…
              {:else}
                {detailLine(file)}
              {/if}
            </span>
          </span>

          <button
            aria-label="Remove file"
            class="remove-btn"
            type="button"
            onclick={(e) => { e.stopPropagation(); appStore.removeAttachment(file.id); }}
          >
            <X class="h-3 w-3" />
          </button>
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .attachment-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.75rem 0.875rem 0;
  }

  /* The composer's own card language: white, hairline ring, generous corner. */
  .attachment-card {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    max-width: 15rem;
    padding: 0.4375rem 0.625rem;
    border-radius: var(--radius-xl);
    background: var(--card);
    box-shadow: inset 0 0 0 1px var(--composer-ring);
    transition: box-shadow 150ms ease, background-color 150ms ease;
  }

  .attachment-card:hover {
    box-shadow: inset 0 0 0 1px var(--composer-ring-focus);
  }

  .attachment-card.is-error {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--error, #d33) 45%, transparent);
  }

  .attachment-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    flex-shrink: 0;
    border-radius: var(--radius-md);
    background: var(--muted);
    color: var(--text-secondary);
  }

  .attachment-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .attachment-name {
    overflow: hidden;
    color: var(--text);
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: -0.005em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-detail {
    overflow: hidden;
    color: var(--text-secondary);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-thumb {
    width: 4rem;
    height: 4rem;
    border-radius: var(--radius-lg);
    object-fit: cover;
    box-shadow: inset 0 0 0 1px var(--composer-ring);
  }

  .remove-btn {
    position: absolute;
    top: -0.375rem;
    right: -0.375rem;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--card);
    color: var(--text-secondary);
    opacity: 0;
    transition: opacity 150ms ease, color 150ms ease;
  }

  .group:hover .remove-btn,
  .remove-btn:focus-visible {
    opacity: 1;
  }

  .remove-btn:hover {
    color: var(--text);
  }

  .spinner {
    width: 0.875rem;
    height: 0.875rem;
    border: 2px solid var(--text-muted);
    border-top-color: transparent;
    border-radius: var(--radius-full);
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
  }
</style>
