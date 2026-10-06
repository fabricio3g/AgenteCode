<svelte:options runes={true} />

<!--
  Character gallery: the empty state of the Roleplay space.

  A search field over a card grid. Selecting a card starts a scene; the pencil
  opens the editor. Keeping this inside the surface (rather than a modal) means
  the gallery is always one click away via "New roleplay".
-->

<script lang="ts">
  import { Button } from '$lib/components/ui';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import { Plus, Upload } from 'lucide-svelte';
  import type { CharacterCard } from '$lib/types/chat';
  import { charactersStore } from './characters.svelte';
  import { parseCharacterCardFile } from '$lib/services/character-card';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import { deleteCharacter, duplicateCharacter } from './library-actions.svelte';
  import LibraryCard from './LibraryCard.svelte';
  import LibraryEmpty from './LibraryEmpty.svelte';
  import LibraryToolbar from './LibraryToolbar.svelte';

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

<div class="library-shelf mx-auto w-full px-6 pb-6" style="max-width: var(--thread-width);">
  <LibraryToolbar bind:query placeholder={charactersStore.characters.length ? 'Search characters' : ''}>
    <Button variant="outline" size="sm" type="button" disabled={importing} onclick={() => importInput?.click()}>
      <Upload /> {importing ? 'Importing…' : copy.roleplay.importCharacter}
    </Button>
    <Button variant="outline" size="sm" type="button" onclick={onnew}><Plus /> {copy.roleplay.newCharacter}</Button>
  </LibraryToolbar>
  <input bind:this={importInput} class="hidden" type="file" accept=".json,.png,application/json,image/png" onchange={onImportFile} />

  {#if !charactersStore.characters.length}
    <LibraryEmpty title={copy.roleplay.pickCharacter} hint={copy.roleplay.pickCharacterHint} action={copy.roleplay.newCharacter} onaction={onnew} />
  {:else if !filtered.length}
    <LibraryEmpty title={copy.empty.noMatches} action="Clear search" onaction={() => (query = '')} />
  {:else}
    <div class="library-grid">
      {#each filtered as card (card.id)}
        <LibraryCard
          kind="character"
          title={card.name}
          subtitle={card.tagline}
          meta={card.creator ? [`by ${card.creator}`] : []}
          tags={card.tags ?? []}
          onopen={() => onpick(card)}
          onedit={() => onedit(card)}
          onduplicate={() => void duplicateCharacter(card)}
          ondelete={() => deleteCharacter(card)}
        >
          {#snippet cover()}<Avatar size="fill" name={card.name ?? ''} image={card.avatar} />{/snippet}
        </LibraryCard>
      {/each}
    </div>
  {/if}
</div>
