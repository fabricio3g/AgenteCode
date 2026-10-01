<svelte:options runes={true} />

<!--
  Roleplay library: the space's home when no scene is active.

  Three shelves — worlds, characters, personas — plus a direct "New scene"
  entry point for a quick group or one-on-one without a world.
-->

<script lang="ts">
  import { Plus } from 'lucide-svelte';
  import type { CharacterCard, RoleplayWorld, UserPersona } from '$lib/types/chat';
  import CharacterGallery from './CharacterGallery.svelte';
  import WorldGallery from './WorldGallery.svelte';
  import PersonaGallery from './PersonaGallery.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';

  type Shelf = 'worlds' | 'characters' | 'personas';

  interface Props {
    onpickCharacter: (character: CharacterCard) => void;
    oneditCharacter: (character: CharacterCard) => void;
    onnewCharacter: () => void;
    onpickWorld: (world: RoleplayWorld) => void;
    oneditWorld: (world: RoleplayWorld) => void;
    onnewWorld: () => void;
    oneditPersona: (persona: UserPersona) => void;
    onnewPersona: () => void;
    onnewScene: () => void;
    /** The active shelf; the parent switches it after a save. */
    shelf?: Shelf;
  }

  let {
    onpickCharacter,
    oneditCharacter,
    onnewCharacter,
    onpickWorld,
    oneditWorld,
    onnewWorld,
    oneditPersona,
    onnewPersona,
    onnewScene,
    shelf = $bindable<Shelf>('characters')
  }: Props = $props();

  const tabs: Array<{ id: Shelf; label: string }> = [
    { id: 'worlds', label: 'Worlds' },
    { id: 'characters', label: 'Characters' },
    { id: 'personas', label: 'Personas' }
  ];
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="mx-auto flex w-full flex-wrap items-center gap-2 px-6 pt-4" style="max-width: var(--thread-width);">
    <SegmentedControl value={shelf} options={tabs.map((tab) => ({ value: tab.id, label: tab.label }))} label="Roleplay library" variant="tabs" onchange={(value) => (shelf = value as Shelf)} />
    <span class="flex-1"></span>
    <button type="button" class="ui-chip is-primary new-scene" onclick={onnewScene}><Plus /> New scene</button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto pt-3">
    {#if shelf === 'worlds'}
      <WorldGallery onpick={onpickWorld} onedit={oneditWorld} onnew={onnewWorld} />
    {:else if shelf === 'characters'}
      <CharacterGallery onpick={onpickCharacter} onedit={oneditCharacter} onnew={onnewCharacter} />
    {:else}
      <PersonaGallery onedit={oneditPersona} onnew={onnewPersona} />
    {/if}
  </div>
</div>

<style>
  .new-scene {
    height: 1.875rem;
    padding: 0 0.85rem;
    font-size: 12.5px;
  }
</style>
