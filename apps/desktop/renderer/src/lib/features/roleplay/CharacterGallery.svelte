<svelte:options runes={true} />

<!--
  Character gallery: the empty state of the Roleplay space.

  A search field over a card grid. Selecting a card starts a scene; the pencil
  opens the editor. Keeping this inside the surface (rather than a modal) means
  the gallery is always one click away via "New roleplay".
-->

<script lang="ts">
  import UiFileInput from '$lib/components/ui/FileInput.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Button } from '$lib/components/ui';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import { Upload } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { CharacterCard } from '$lib/types/chat';
  import { charactersStore } from './characters.svelte';
  import { roleplayStore } from './roleplay.svelte';
  import { parseCharacterCardFile } from '$lib/services/character-card';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import { deleteCharacter, duplicateCharacter } from './library-actions.svelte';
  import LibraryCard from './LibraryCard.svelte';
  import LibraryEmpty from './LibraryEmpty.svelte';
  import LibraryToolbar from './LibraryToolbar.svelte';

  interface Props {
    onpick: (character: CharacterCard) => void;
    /** Scene setup for this character: cast, persona and opening before it starts. */
    oncustomize: (character: CharacterCard) => void;
    onedit: (character: CharacterCard) => void;
    onnew: () => void;
  }

  let { onpick, oncustomize, onedit, onnew }: Props = $props();

  let query = $state('');
  let importInput = $state<HTMLInputElement | undefined>();
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
      toastStore.success($t('roleplay.library.imported', { values: { name: saved.name } }));
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : $t('roleplay.library.importFailed'));
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

<div class="library-shelf">
  <LibraryToolbar bind:query placeholder={charactersStore.characters.length ? $t('roleplay.library.searchCharacters') : ''}>
    <Button variant="outline" type="button" disabled={importing} onclick={() => importInput?.click()}>
      <Upload /> {importing ? $t('roleplay.library.importing') : $t('roleplay.library.import')}
    </Button>
  </LibraryToolbar>
  <UiFileInput bind:ref={importInput} class={uiClass("hidden")}  accept=".json,.png,application/json,image/png" onchange={onImportFile} />

  {#if !charactersStore.characters.length}
    <LibraryEmpty title={$t('roleplay.library.noCharacters')} hint={$t('roleplay.library.noCharactersHint')} action={$t('roleplay.library.newCharacter')} onaction={onnew} />
  {:else if !filtered.length}
    <LibraryEmpty title={copy.empty.noMatches} action={$t('roleplay.library.clearSearch')} onaction={() => (query = '')} />
  {:else}
    <div class="library-grid">
      {#each filtered as card (card.id)}
        <LibraryCard
          title={card.name}
          subtitle={roleplayStore.previewText(card.tagline ?? '', { char: card.name, seed: card.id })}
          tags={card.tags ?? []}
          editLabel={$t('roleplay.library.editCharacter')}
          optionsLabel={$t('roleplay.library.characterOptions')}
          customizeLabel={$t('roleplay.library.customize')}
          oncustomize={() => oncustomize(card)}
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
