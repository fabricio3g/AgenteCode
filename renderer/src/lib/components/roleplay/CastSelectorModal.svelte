<svelte:options runes={true} />

<script lang="ts">
  import { Search, X } from 'lucide-svelte';
  import type { RoleplayCharacter } from '$lib/types/roleplay';

  let {
    characters,
    initialSelectedIds,
    onEdit,
    onApply,
    onClose
  }: {
    characters: RoleplayCharacter[];
    initialSelectedIds: string[];
    onEdit: (id: string) => void;
    onApply: (ids: string[]) => void;
    onClose: () => void;
  } = $props();

  let query = $state('');
  let draftSelectedIds = $state<string[]>([]);
  let previewCharacterId = $state<string | null>(null);

  $effect(() => {
    draftSelectedIds = [...initialSelectedIds];
  });

  const filteredCharacters = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return characters;
    return characters.filter((character) =>
      character.name.toLowerCase().includes(q) ||
      String(character.description || '').toLowerCase().includes(q)
    );
  });

  const selectedCount = $derived(draftSelectedIds.length);
  const previewCharacter = $derived(
    previewCharacterId ? characters.find((character) => character.id === previewCharacterId) || null : null
  );

  function toggleCharacter(characterId: string) {
    const selected = new Set(draftSelectedIds);
    if (selected.has(characterId)) selected.delete(characterId);
    else selected.add(characterId);
    draftSelectedIds = Array.from(selected);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-[260] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true" tabindex="-1" onclick={onClose}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section class="cast-modal w-full max-w-xl rounded-2xl bg-[var(--surface)] shadow-2xl" onclick={(event) => event.stopPropagation()}>
    <header class="flex items-center justify-between px-4 py-3">
      <div>
        <h2 class="text-sm font-semibold text-[var(--text)]">Scene Cast</h2>
        <p class="text-xs text-[var(--text-muted)]">{selectedCount} selected</p>
      </div>
      <button class="icon-btn" aria-label="Close" onclick={onClose}>
        <X class="h-4 w-4" />
      </button>
    </header>

    <div class="px-4 pb-3">
      <label class="relative block">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
        <input class="field w-full py-2 pl-8 pr-3 text-sm" bind:value={query} placeholder="Search characters" />
      </label>
    </div>

    <div class="max-h-[52vh] overflow-y-auto px-2 pb-2">
      {#if filteredCharacters.length}
        <div class="grid grid-cols-1 gap-1">
          {#each filteredCharacters as character (character.id)}
            {@const isSelected = draftSelectedIds.includes(character.id)}
            <div class="row rounded-xl p-2">
              <div class="flex items-center gap-3">
                {#if character.avatarDataUrl}
                  <img class="avatar h-11 w-11 rounded-full object-cover" src={character.avatarDataUrl} alt="" />
                {:else}
                  <span class="avatar avatar-fallback flex h-11 w-11 items-center justify-center rounded-full text-xs font-semibold">
                    {character.name.slice(0, 1)}
                  </span>
                {/if}
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium text-[var(--text)]">{character.name}</span>
                  <span class="block truncate text-xs text-[var(--text-muted)]">{character.description?.trim() || 'No description'}</span>
                </span>
                <button class="edit-btn text-xs" onclick={() => (previewCharacterId = character.id)}>See more</button>
                <button class="edit-btn text-xs" onclick={() => onEdit(character.id)}>Edit</button>
                <button class="pick-btn text-xs" class:is-selected={isSelected} onclick={() => toggleCharacter(character.id)}>
                  {isSelected ? 'Selected' : 'Add'}
                </button>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <p class="px-2 py-8 text-center text-sm text-[var(--text-muted)]">No characters found</p>
      {/if}
    </div>

    <footer class="flex items-center justify-end gap-2 px-4 py-3">
      <button class="action-btn px-3 py-2 text-sm" onclick={onClose}>Cancel</button>
      <button class="action-btn primary px-3 py-2 text-sm" onclick={() => onApply(draftSelectedIds)}>Apply</button>
    </footer>
  </section>
</div>

{#if previewCharacter}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-[270] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true" tabindex="-1" onclick={() => (previewCharacterId = null)}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <section class="detail-modal w-full max-w-lg rounded-2xl bg-[var(--surface)] shadow-2xl" onclick={(event) => event.stopPropagation()}>
      <header class="flex items-center justify-between px-4 py-3">
        <h3 class="truncate text-sm font-semibold text-[var(--text)]">{previewCharacter.name}</h3>
        <button class="icon-btn" aria-label="Close details" onclick={() => (previewCharacterId = null)}>
          <X class="h-4 w-4" />
        </button>
      </header>
      <div class="max-h-[58vh] overflow-y-auto p-4 pt-1">
        <div class="flex items-start gap-3">
          {#if previewCharacter.avatarDataUrl}
            <img class="avatar h-14 w-14 rounded-full object-cover" src={previewCharacter.avatarDataUrl} alt="" />
          {:else}
            <span class="avatar avatar-fallback flex h-14 w-14 items-center justify-center rounded-full text-sm font-semibold">
              {previewCharacter.name.slice(0, 1)}
            </span>
          {/if}
          <p class="whitespace-pre-wrap text-sm leading-6 text-[var(--text)]">
            {previewCharacter.description?.trim() || 'No description'}
          </p>
        </div>
      </div>
      <footer class="flex justify-end px-4 py-3">
        <button class="action-btn px-3 py-2 text-sm" onclick={() => (previewCharacterId = null)}>Close</button>
      </footer>
    </section>
  </div>
{/if}

<style>
  .cast-modal, .detail-modal {
    border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  }
  .icon-btn, .action-btn {
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
  .action-btn:hover, .icon-btn:hover, .row:hover {
    background: var(--surface-hover);
  }
  .action-btn.primary {
    background: #E20E0F;
    border-color: #E20E0F;
    color: var(--primary-fg);
  }
  .field {
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    outline: none;
  }
  .field:focus {
    border-color: var(--border-active);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .row {
    border: 1px solid transparent;
    transition: background 0.15s ease, border-color 0.15s ease;
    background: transparent;
  }
  .row:hover {
    background: var(--surface-hover);
    border-color: transparent;
  }
  .avatar-fallback {
    background: var(--surface-hover);
    color: var(--text);
  }
  .pick-btn {
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text-secondary);
    min-width: 76px;
    text-align: center;
    padding: 0.25rem 0.6rem;
    font-weight: 600;
  }
  .pick-btn.is-selected {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--text);
  }
  .edit-btn {
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text-secondary);
    min-width: 56px;
    padding: 0.25rem 0.6rem;
    font-weight: 600;
  }
  .edit-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
</style>
