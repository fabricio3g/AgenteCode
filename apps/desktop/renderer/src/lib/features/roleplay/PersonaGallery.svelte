<svelte:options runes={true} />

<!--
  Persona gallery: who you are in the story. Clicking a persona edits it;
  duplicate and delete live on each card.
-->

<script lang="ts">
  import { Button } from '$lib/components/ui';
  import { Plus } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import type { UserPersona } from '$lib/types/chat';
  import { charactersStore } from './characters.svelte';
  import { roleplayStore } from './roleplay.svelte';
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

<div class="library-shelf">
  <LibraryToolbar>
    <Button variant="outline" type="button" onclick={onnew}><Plus /> {$t('roleplay.library.newPersona')}</Button>
  </LibraryToolbar>

  {#if !charactersStore.personas.length}
    <LibraryEmpty title={$t('roleplay.library.noPersonas')} hint={$t('roleplay.library.noPersonasHint')} action={$t('roleplay.library.newPersona')} onaction={onnew} />
  {:else}
    <div class="library-grid">
      {#each charactersStore.personas as persona (persona.id)}
        <LibraryCard
          title={persona.name}
          editLabel={$t('roleplay.library.editPersona')}
          optionsLabel={$t('roleplay.library.personaOptions')}
          subtitle={roleplayStore.previewText(persona.description ?? '', { personaId: persona.id, seed: persona.id })}
          badge={persona.isDefault ? $t('roleplay.library.defaultBadge') : ''}
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
