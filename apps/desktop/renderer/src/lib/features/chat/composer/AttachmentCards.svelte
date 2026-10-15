<svelte:options runes={true} />

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

  import { X } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { getFileIcon } from '$lib/utils/doc-utils';
  import { fileTypeLabel } from '$lib/features/chat/document-surface';
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

  /**
   * Forty documents must not push the composer off the window. Collapsed shows
   * the first six cards and a "+N more" chip; expanding shows every card in a
   * bounded, scrollable row. The chip sits below the grid, so it stays
   * reachable at both ends.
   */
  const COLLAPSED_LIMIT = 6;
  let expanded = $state(false);
  const total = $derived(appStore.pendingAttachments.length);
  const hidden = $derived(Math.max(0, total - COLLAPSED_LIMIT));
  const visible = $derived(
    expanded || hidden === 0 ? appStore.pendingAttachments : appStore.pendingAttachments.slice(0, COLLAPSED_LIMIT)
  );
</script>

{#if total > 0}
  <div class="attachment-area">
    <div class="attachment-row" class:is-scroll={expanded && hidden > 0}>
      {#each visible as file (file.id)}
        {#if file.kind === 'image' && file.status === 'ready' && (file.preview || file.base64)}
          <div class="group relative">
            <img src={file.base64 || file.preview} alt={file.name} class="attachment-thumb" />
            <IconButton label={"Remove image"} size="xs" variant="ghost"

              class={uiClass("remove-btn", "ui-local-6833b011")}
              type="button"
              onclick={(e) => { e.stopPropagation(); appStore.removeAttachment(file.id); }}
            >
              <X class="h-3 w-3" />
            </IconButton>
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
              <span class="attachment-detail" title={file.error || file.warning || undefined}>
                {#if file.status === 'error'}
                  <span class="text-error">{file.error || 'Could not read this file'}</span>
                {:else if file.status === 'processing'}
                  {file.processingMode === 'transcription' ? 'Transcribing…' : file.processingMode === 'ocr' ? 'Reading text…' : 'Reading…'}
                {:else}
                  {detailLine(file)}{file.warning ? ' · Partial reading' : ''}
                {/if}
              </span>
            </span>

            <IconButton label={"Remove file"} size="xs" variant="ghost"

              class={uiClass("remove-btn", "ui-local-6833b011")}
              type="button"
              onclick={(e) => { e.stopPropagation(); appStore.removeAttachment(file.id); }}
            >
              <X class="h-3 w-3" />
            </IconButton>
          </div>
        {/if}
      {/each}
    </div>
    {#if hidden > 0}
      <Button variant="plain" type="button" class={uiClass("more-chip", "ui-local-6833b011")} aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
        {expanded ? 'Show less' : `+${hidden} more`}
      </Button>
    {/if}
  </div>
{/if}

<style>
  .attachment-area {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 0.875rem 0;
  }

  .attachment-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  /* Expanded: every card is reachable, but the row can never grow past a few
     lines — the composer keeps its place on screen. */
  .attachment-row.is-scroll {
    max-height: 11rem;
    overflow-y: auto;
    padding-right: 0.25rem;
  }

  /* Below the grid, not inside it: reachable whether the list is collapsed or
     scrolled. Same muted pill as the composer's other chips. */
  :global(.more-chip.ui-local-6833b011) {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    height: 1.5rem;
    padding: 0 0.5rem;
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-weight: 500;
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }

  :global(.more-chip:hover.ui-local-6833b011) {
    background: var(--surface-hover);
    color: var(--text);
  }

  :global(.more-chip:focus-visible.ui-local-6833b011) {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
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
    transition: box-shadow var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
  }

  .attachment-card:hover {
    box-shadow: inset 0 0 0 1px var(--ring);
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

  :global(.remove-btn.ui-local-6833b011) {
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
    transition: opacity var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }

  .group:hover :global(.remove-btn.ui-local-6833b011),
  :global(.remove-btn:focus-visible.ui-local-6833b011) {
    opacity: 1;
  }

  :global(.remove-btn:hover.ui-local-6833b011) {
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
