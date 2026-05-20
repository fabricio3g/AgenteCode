<svelte:options runes={true} />

<script lang="ts">
  import { BookOpen, Search, X } from 'lucide-svelte';
  import type { RoleplayLorebook } from '$lib/types/roleplay';

  let {
    lorebooks,
    initialSelectedIds,
    onApply,
    onClose
  }: {
    lorebooks: RoleplayLorebook[];
    initialSelectedIds: string[];
    onApply: (ids: string[]) => void;
    onClose: () => void;
  } = $props();

  let query = $state('');
  let draftSelectedIds = $state<string[]>([]);

  $effect(() => {
    draftSelectedIds = [...initialSelectedIds];
  });

  const filteredLorebooks = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return lorebooks;
    return lorebooks.filter((book) =>
      book.name.toLowerCase().includes(q) ||
      book.entries.some((entry) =>
        entry.content.toLowerCase().includes(q) ||
        entry.keys.some((key) => key.toLowerCase().includes(q))
      )
    );
  });

  function toggleLorebook(id: string) {
    const selected = new Set(draftSelectedIds);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    draftSelectedIds = Array.from(selected);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-[270] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true" tabindex="-1" onclick={onClose}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section class="selector w-full max-w-xl rounded-2xl bg-[var(--surface)] shadow-2xl" onclick={(event) => event.stopPropagation()}>
    <header class="flex items-center justify-between px-4 py-3">
      <div>
        <h2 class="text-sm font-semibold text-[var(--text)]">Select lorebooks</h2>
        <p class="text-xs text-[var(--text-muted)]">{draftSelectedIds.length} selected for this scene</p>
      </div>
      <button class="icon-btn" aria-label="Close lorebook selector" onclick={onClose}>
        <X class="h-4 w-4" />
      </button>
    </header>

    <div class="px-4 pb-3">
      <label class="relative block">
        <Search class="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
        <input class="search-input w-full py-2 pl-9 pr-3 text-sm" bind:value={query} placeholder="Search lorebooks, keys, or content" />
      </label>
    </div>

    <div class="max-h-[48vh] overflow-y-auto px-2 pb-2">
      {#if filteredLorebooks.length}
        {#each filteredLorebooks as book (book.id)}
          {@const isSelected = draftSelectedIds.includes(book.id)}
          <button class="book-row" class:is-selected={isSelected} onclick={() => toggleLorebook(book.id)}>
            <span class="book-icon">
              <BookOpen class="h-4 w-4" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-semibold text-[var(--text)]">{book.name}</span>
              <span class="block truncate text-xs text-[var(--text-muted)]">
                {book.entries.length} entries
                {#if book.entries[0]?.keys?.length}
                  · {book.entries[0].keys.slice(0, 3).join(', ')}
                {/if}
              </span>
            </span>
            <span class="select-state">{isSelected ? 'Selected' : 'Select'}</span>
          </button>
        {/each}
      {:else}
        <p class="px-4 py-10 text-center text-sm text-[var(--text-muted)]">No lorebooks found.</p>
      {/if}
    </div>

    <footer class="flex items-center justify-between gap-3 px-4 py-3">
      <button class="ghost-btn px-3 py-2 text-sm" onclick={() => (draftSelectedIds = [])}>Clear</button>
      <div class="flex items-center gap-2">
        <button class="ghost-btn px-3 py-2 text-sm" onclick={onClose}>Cancel</button>
        <button class="primary-btn px-4 py-2 text-sm" onclick={() => onApply(draftSelectedIds)}>Apply</button>
      </div>
    </footer>
  </section>
</div>

<style>
  .selector {
    border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  }
  .icon-btn, .ghost-btn, .primary-btn {
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text);
  }
  .icon-btn {
    display: inline-flex;
    height: 32px;
    width: 32px;
    align-items: center;
    justify-content: center;
  }
  .icon-btn:hover, .ghost-btn:hover, .book-row:hover {
    background: var(--surface-hover);
  }
  .primary-btn {
    background: #E20E0F;
    border-color: #E20E0F;
    color: var(--primary-fg);
    font-weight: 700;
  }
  .search-input {
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    outline: none;
  }
  .search-input:focus {
    border-color: var(--border-active);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .book-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.75rem;
    border: 1px solid transparent;
    border-radius: 12px;
    background: transparent;
    color: var(--text);
    padding: 0.75rem 0.85rem;
    text-align: left;
  }
  .book-row.is-selected {
    background: var(--surface-hover);
  }
  .book-icon {
    display: inline-flex;
    height: 34px;
    width: 34px;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    background: var(--surface-hover);
    color: var(--text-secondary);
  }
  .select-state {
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-weight: 700;
  }
</style>
