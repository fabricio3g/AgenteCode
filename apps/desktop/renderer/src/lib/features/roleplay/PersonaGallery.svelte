<svelte:options runes={true} />

<!--
  Persona gallery: who you are in the story. Clicking a persona edits it;
  duplicate and delete live on each card.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import type { UserPersona } from '$lib/types/chat';
  import { charactersStore } from './characters.svelte';
  import { roleplayStore } from './roleplay.svelte';
  import { deletePersona, duplicatePersona } from './library-actions.svelte';
  import LibraryCard from './LibraryCard.svelte';
  import LibraryEmpty from './LibraryEmpty.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    onedit: (persona: UserPersona) => void;
    onnew: () => void;
    /** The library's search, applied to this shelf. */
    query?: string;
    onclear?: () => void;
  }

  let { onedit, onnew, query = '', onclear }: Props = $props();

  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return charactersStore.personas;
    return charactersStore.personas.filter((persona) =>
      [persona.name, persona.description].filter(Boolean).some((field) => String(field).toLowerCase().includes(needle))
    );
  });
</script>

<div class="library-shelf">

  {#if !charactersStore.personas.length}
    <LibraryEmpty title={$t('roleplay.library.noPersonas')} hint={$t('roleplay.library.noPersonasHint')} action={$t('roleplay.library.newPersona')} onaction={onnew} />
  {:else if !filtered.length}
    <LibraryEmpty title={copy.empty.noMatches} action={$t('roleplay.library.clearSearch')} onaction={() => onclear?.()} />
  {:else}
    <div class="library-grid">
      {#each filtered as persona (persona.id)}
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
