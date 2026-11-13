<svelte:options runes={true} />

<!--
  Roleplay library: the space's home when no scene is active.

  The same page as Artifacts and Files: the shared header (title, one line,
  the create action for the shelf in view, plus Import on Characters) and the
  shared filter bar, where the three shelves — characters, worlds, personas —
  are chips with their counts and one search covers the shelf in view. A new
  scene starts from the sidebar's "New".
-->

<script lang="ts">
  import { Button, FilterBar, FilterChip, PageHeader } from '$lib/components/ui';
  import { Plus, Upload } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import { copy } from '$lib/copy';
  import type { CharacterCard, RoleplayWorld, UserPersona } from '$lib/types/chat';
  import CharacterGallery from './CharacterGallery.svelte';
  import WorldGallery from './WorldGallery.svelte';
  import PersonaGallery from './PersonaGallery.svelte';
  import { charactersStore } from './characters.svelte';
  import { worldsStore } from './worlds.svelte';

  type Shelf = 'worlds' | 'characters' | 'personas';

  interface Props {
    onpickCharacter: (character: CharacterCard) => void;
    oncustomizeCharacter: (character: CharacterCard) => void;
    oneditCharacter: (character: CharacterCard) => void;
    onnewCharacter: () => void;
    onpickWorld: (world: RoleplayWorld) => void;
    oneditWorld: (world: RoleplayWorld) => void;
    onnewWorld: () => void;
    oneditPersona: (persona: UserPersona) => void;
    onnewPersona: () => void;
    /** The active shelf; the parent switches it after a save. */
    shelf?: Shelf;
  }

  let {
    onpickCharacter,
    oncustomizeCharacter,
    oneditCharacter,
    onnewCharacter,
    onpickWorld,
    oneditWorld,
    onnewWorld,
    oneditPersona,
    onnewPersona,
    shelf = $bindable<Shelf>('characters')
  }: Props = $props();

  let query = $state('');
  let characters = $state<CharacterGallery>();

  // A new shelf starts unfiltered: a search for a character means nothing to worlds.
  $effect(() => {
    void shelf;
    query = '';
  });

  const shelves = $derived<Array<{ id: Shelf; label: string; count: number }>>([
    { id: 'characters', label: $t('roleplay.library.shelf.characters'), count: charactersStore.characters.length },
    { id: 'worlds', label: $t('roleplay.library.shelf.worlds'), count: worldsStore.worlds.length },
    { id: 'personas', label: $t('roleplay.library.shelf.personas'), count: charactersStore.personas.length }
  ]);

  const create = $derived(
    shelf === 'worlds' ? { label: $t('roleplay.library.newWorld'), run: onnewWorld }
      : shelf === 'personas' ? { label: $t('roleplay.library.newPersona'), run: onnewPersona }
        : { label: $t('roleplay.library.newCharacter'), run: onnewCharacter }
  );

  const searchPlaceholder = $derived(
    shelf === 'worlds' ? $t('roleplay.library.searchWorlds')
      : shelf === 'personas' ? $t('roleplay.library.searchPersonas')
        : $t('roleplay.library.searchCharacters')
  );
</script>

<div class="roleplay-library flex min-h-0 min-w-0 flex-1 flex-col">
  <div class="library-scroll min-h-0 flex-1 overflow-y-auto">
    <div class="library-page">
      <PageHeader title={copy.spaces.roleplay} description={$t('roleplay.library.description')}>
        {#snippet actions()}
          {#if shelf === 'characters'}
            <Button variant="ghost" size="sm" type="button" onclick={() => characters?.pickImport()}><Upload /> {$t('roleplay.library.import')}</Button>
          {/if}
          <Button size="sm" type="button" onclick={() => create.run()}><Plus /> {create.label}</Button>
        {/snippet}
      </PageHeader>

      <FilterBar class="library-filters" bind:query placeholder={searchPlaceholder} clearLabel={$t('roleplay.library.clearSearch')} label={$t('roleplay.library.title')}>
        {#snippet chips()}
          {#each shelves as item (item.id)}
            <FilterChip on={shelf === item.id} count={item.count} onclick={() => (shelf = item.id)}>{item.label}</FilterChip>
          {/each}
        {/snippet}
      </FilterBar>

      {#if shelf === 'worlds'}
        <WorldGallery {query} onclear={() => (query = '')} onpick={onpickWorld} onedit={oneditWorld} onnew={onnewWorld} />
      {:else if shelf === 'characters'}
        <CharacterGallery bind:this={characters} {query} onclear={() => (query = '')} onpick={onpickCharacter} oncustomize={oncustomizeCharacter} onedit={oneditCharacter} onnew={onnewCharacter} />
      {:else}
        <PersonaGallery {query} onclear={() => (query = '')} onedit={oneditPersona} onnew={onnewPersona} />
      {/if}
    </div>
  </div>
</div>

<style>
  .roleplay-library { container-type: inline-size; }
  .library-scroll {
    display: flex;
    flex-direction: column;
    overscroll-behavior: contain;
  }
  /* The same page box as Artifacts and Files. */
  .library-page {
    width: 100%;
    max-width: 1100px;
    margin: 0 auto;
    padding: 2rem 2rem 2.5rem;
  }
  .library-page :global(.library-filters) { margin: 1.25rem 0 1.25rem; }
  .roleplay-library :global(.library-shelf) {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .roleplay-library :global(.library-grid) {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.75rem;
  }
  @container (min-width: 38rem) {
    .roleplay-library :global(.library-grid) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @container (min-width: 62rem) {
    .roleplay-library :global(.library-grid) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @container (max-width: 28rem) {
    .library-page { padding-inline: 1rem; }
  }
</style>
