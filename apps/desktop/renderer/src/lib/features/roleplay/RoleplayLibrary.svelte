<svelte:options runes={true} />

<!--
  Roleplay library: the space's home when no scene is active.

  Three shelves — worlds, characters, personas — and one create button for
  the shelf in view. A new scene starts from the sidebar's "New".
-->

<script lang="ts">
  import { Button } from '$lib/components/ui';
  import { Plus } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { CharacterCard, RoleplayWorld, UserPersona } from '$lib/types/chat';
  import CharacterGallery from './CharacterGallery.svelte';
  import WorldGallery from './WorldGallery.svelte';
  import PersonaGallery from './PersonaGallery.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';

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

  const tabs = $derived<Array<{ id: Shelf; label: string }>>([
    { id: 'worlds', label: $t('roleplay.library.shelf.worlds') },
    { id: 'characters', label: $t('roleplay.library.shelf.characters') },
    { id: 'personas', label: $t('roleplay.library.shelf.personas') }
  ]);

  const create = $derived(
    shelf === 'worlds' ? { label: $t('roleplay.library.newWorld'), run: onnewWorld }
      : shelf === 'personas' ? { label: $t('roleplay.library.newPersona'), run: onnewPersona }
        : { label: $t('roleplay.library.newCharacter'), run: onnewCharacter }
  );
</script>

<div class="roleplay-library flex min-h-0 min-w-0 flex-1 flex-col">
  <div class="library-header">
    <SegmentedControl value={shelf} options={tabs.map((tab) => ({ value: tab.id, label: tab.label }))} label={$t('roleplay.library.title')} variant="tabs" shape="rect" onchange={(value) => (shelf = value as Shelf)} />
    <span class="flex-1"></span>
    <Button variant="outline" type="button" onclick={() => create.run()}><Plus /> {create.label}</Button>
  </div>

  <div class="library-scroll min-h-0 flex-1 overflow-y-auto">
    {#if shelf === 'worlds'}
      <WorldGallery onpick={onpickWorld} onedit={oneditWorld} onnew={onnewWorld} />
    {:else if shelf === 'characters'}
      <CharacterGallery onpick={onpickCharacter} oncustomize={oncustomizeCharacter} onedit={oneditCharacter} onnew={onnewCharacter} />
    {:else}
      <PersonaGallery onedit={oneditPersona} onnew={onnewPersona} />
    {/if}
  </div>
</div>

<style>
  .roleplay-library { container-type: inline-size; }
  .library-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    max-width: var(--thread-width);
    margin: 0 auto;
    padding: 1rem 1.5rem;
    flex-shrink: 0;
  }
  .library-scroll {
    display: flex;
    flex-direction: column;
    overscroll-behavior: contain;
    scrollbar-gutter: stable both-edges;
  }
  .roleplay-library :global(.library-shelf) {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    width: 100%;
    max-width: var(--thread-width);
    margin: 0 auto;
    padding: 0 1.5rem 1.5rem;
  }
  .roleplay-library :global(.library-grid) {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.75rem;
  }
  @container (min-width: 38rem) {
    .roleplay-library :global(.library-grid) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @container (max-width: 28rem) {
    .library-header { padding-inline: 1rem; }
    .roleplay-library :global(.library-shelf) { padding-inline: 1rem; }
  }
</style>
