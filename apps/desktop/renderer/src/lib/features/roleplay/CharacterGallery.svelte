<svelte:options runes={true} />

<!--
  Character gallery: the empty state of the Roleplay space.

  A search field over a card grid. Selecting a card starts a scene; the pencil
  opens the editor. Keeping this inside the surface (rather than a modal) means
  the gallery is always one click away via "New roleplay".
-->

<script lang="ts">
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import { Plus, Search, Pencil, Upload } from 'lucide-svelte';
  import type { CharacterCard } from '$lib/types/chat';
  import { charactersStore } from './characters.svelte';
  import { parseCharacterCardFile } from '$lib/services/character-card';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    onpick: (character: CharacterCard) => void;
    onedit: (character: CharacterCard) => void;
    onnew: () => void;
  }

  let { onpick, onedit, onnew }: Props = $props();

  let query = $state('');
  let importInput: HTMLInputElement | undefined;
  let importing = $state(false);

  async function onImportFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    importing = true;
    try {
      const card = await parseCharacterCardFile(file);
      const saved = await charactersStore.save(card);
      toastStore.success(`Imported ${saved.name}`);
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Import failed.');
    } finally {
      importing = false;
    }
  }

  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return charactersStore.characters;
    return charactersStore.characters.filter((card) =>
      [card.name, card.tagline, card.creator, ...(card.tags || [])]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle))
    );
  });
</script>

<div class="gallery mx-auto w-full px-6 pb-6" style="max-width: var(--thread-width);">
  <div class="mb-4 flex items-center gap-2">
    <div class="search-field">
      <Search class="search-icon" />
      <input
        class="aui-input search-input w-full"
        bind:value={query}
        placeholder={copy.roleplay.characters}
        aria-label={copy.roleplay.characters}
      />
    </div>
    <button type="button" class="aui-btn shrink-0" disabled={importing} onclick={() => importInput?.click()}>
      <Upload class="size-4" />
      <span>{importing ? 'Importing…' : copy.roleplay.importCharacter}</span>
    </button>
    <input
      bind:this={importInput}
      class="hidden"
      type="file"
      accept=".json,.png,application/json,image/png"
      onchange={onImportFile}
    />
    <button type="button" class="aui-btn aui-btn-primary shrink-0" onclick={onnew}>
      <Plus class="size-4" />
      <span>{copy.roleplay.newCharacter}</span>
    </button>
  </div>

  {#if !charactersStore.characters.length}
    <div class="empty-state py-14 text-center">
      <p class="text-[15px] font-medium text-foreground">{copy.roleplay.pickCharacter}</p>
      <p class="mt-1 text-[13px] text-muted-foreground">{copy.roleplay.pickCharacterHint}</p>
    </div>
  {:else if !filtered.length}
    <div class="py-14 text-center text-[13px] text-muted-foreground">{copy.empty.noMatches}</div>
  {:else}
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {#each filtered as card (card.id)}
        <div class="character-card group relative">
          <button
            type="button"
            class="card-hit flex w-full flex-col items-center gap-2 p-4 text-center"
            onclick={() => onpick(card)}
          >
            <div class="avatar">
              <Avatar size="fill" name={card.name ?? ''} image={card.avatar} />
            </div>
            <div class="min-w-0">
              <div class="truncate text-[14px] font-medium text-foreground">{card.name}</div>
              {#if card.tagline}
                <div class="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{card.tagline}</div>
              {/if}
            </div>
            {#if card.tags?.length}
              <div class="flex flex-wrap justify-center gap-1">
                {#each card.tags.slice(0, 3) as tag (tag)}
                  <span class="tag">{tag}</span>
                {/each}
              </div>
            {/if}
          </button>
          <button
            type="button"
            class="edit-btn aui-icon-button absolute right-2 top-2 size-7 opacity-0 transition group-hover:opacity-100"
            onclick={() => onedit(card)}
            aria-label="Edit character"
          >
            <Pencil class="size-3.5" />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* The field owns the icon's geometry instead of Tailwind utilities: the
     icon must sit above the input's background and clear of the text. */
  .search-field {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    min-width: 0;
  }

  .search-field :global(.search-icon) {
    position: absolute;
    left: 0.75rem;
    top: 50%;
    z-index: 1;
    width: 1rem;
    height: 1rem;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }

  /* Scoped rule beats .aui-input's shorthand padding; a Tailwind pl-* utility
     loses to it because both are single-class specificity. */
  .search-input {
    padding-left: 2.5rem;
  }

  .character-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      background-color var(--motion-fast) var(--motion-ease);
  }

  .character-card:hover {
    border-color: var(--border-hover);
    background: var(--surface-hover);
  }

  .card-hit {
    cursor: pointer;
  }

  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.5rem;
    height: 3.5rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--text-muted);
    font-size: 1.25rem;
    font-weight: 600;
  }


  .tag {
    padding: 0.0625rem 0.4375rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--text-muted);
    font-size: 0.6875rem;
  }

  .edit-btn {
    background: var(--popover);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-sm);
  }
</style>
