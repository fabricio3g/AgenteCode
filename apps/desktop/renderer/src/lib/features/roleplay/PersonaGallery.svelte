<svelte:options runes={true} />

<!--
  Persona gallery: who you are in the story. Clicking a persona edits it;
  duplicate and delete live on each card.
-->

<script lang="ts">
  import { Button } from '$lib/components/ui';
  import { Plus } from 'lucide-svelte';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import type { UserPersona } from '$lib/types/chat';
  import { charactersStore } from './characters.svelte';
  import { deletePersona, duplicatePersona } from './library-actions.svelte';
  import LibraryCard from './LibraryCard.svelte';
  import LibraryEmpty from './LibraryEmpty.svelte';
  import LibraryToolbar from './LibraryToolbar.svelte';

  interface Props {
    onedit: (persona: UserPersona) => void;
    onnew: () => void;
  }

  let { onedit, onnew }: Props = $props();
</script>

<div class="library-shelf mx-auto w-full px-6 pb-6" style="max-width: var(--thread-width);">
  <LibraryToolbar>
    <Button variant="outline" size="sm" type="button" onclick={onnew}><Plus /> New persona</Button>
  </LibraryToolbar>

  {#if !charactersStore.personas.length}
    <LibraryEmpty title="No personas yet" hint="Create one to tell the cast who you are in the story." action="New persona" onaction={onnew} />
  {:else}
    <div class="library-grid">
      {#each charactersStore.personas as persona (persona.id)}
        <LibraryCard
          kind="persona"
          title={persona.name}
          subtitle={persona.description}
          badge={persona.isDefault ? 'Default' : ''}
          onopen={() => onedit(persona)}
          onedit={() => onedit(persona)}
          onduplicate={() => void duplicatePersona(persona)}
          ondelete={() => deletePersona(persona)}
        >
          {#snippet cover()}<Avatar size="fill" name={persona.name ?? ''} image={persona.avatar} />{/snippet}
        </LibraryCard>
      {/each}
    </div>
  {/if}
</div>
