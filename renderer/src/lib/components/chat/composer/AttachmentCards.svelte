<svelte:options runes={true} />

<script lang="ts">
  import { X, FileText } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
</script>

{#if appStore.pendingAttachments.length > 0}
  <div class="flex flex-wrap gap-2 px-3 pt-2.5">
    {#each appStore.pendingAttachments as file (file.id)}
      {#if file.kind === 'image' && (file.preview || file.base64)}
        <div class="group relative">
          <img src={file.base64 || file.preview} alt={file.name} class="h-16 w-16 rounded-xl border border-[var(--border)] object-cover shadow-[var(--shadow-xs)]" />
          <button
            aria-label="Remove image"
            class="chateaui-pill absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100"
            style="--chateaui-pill-bg: var(--surface); --chateaui-pill-border: var(--border);"
            type="button"
            onclick={(e) => { e.stopPropagation(); appStore.removeAttachment(file.id); }}
          >
            <X class="h-3 w-3" />
          </button>
        </div>
      {:else}
        <div class="chateaui-card group relative flex items-center gap-2 px-3 py-2" style="--chateaui-card-bg: var(--surface-hover);">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-overlay-light">
            {#if file.status === 'processing'}
              <div class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-transparent"></div>
            {:else}
              <FileText class="h-4 w-4 text-[var(--text-tertiary)]" />
            {/if}
          </div>
          <div class="min-w-0">
            <div class="text-xs font-medium text-[var(--text)] line-clamp-1 max-w-[140px]">{file.name}</div>
            <div class="text-[10px] text-[var(--text-muted)]">
              {#if file.status === 'error'}
                <span class="text-error">Error</span>
              {:else if file.status === 'processing'}
                Indexing...
              {:else}
                Ready
              {/if}
            </div>
          </div>
          <button
            aria-label="Remove file"
            class="chateaui-pill absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100"
            style="--chateaui-pill-bg: var(--surface); --chateaui-pill-border: var(--border);"
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
