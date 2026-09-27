<svelte:options runes={true} />

<!--
  Persona gallery: every user character available to scenes.

  Personas are edited here, not selected — selection happens in scene setup and
  in the strip above the composer.
-->

<script lang="ts">
  import { Pencil, Plus, Trash2 } from 'lucide-svelte';
  import type { UserPersona } from '$lib/types/chat';
  import { charactersStore } from './characters.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';

  interface Props {
    onedit: (persona: UserPersona) => void;
    onnew: () => void;
  }

  let { onedit, onnew }: Props = $props();

  function confirmRemove(persona: UserPersona) {
    confirmStore.show({
      title: `Delete ${persona.name || 'persona'}?`,
      message: 'Scenes keep running; they simply lose this persona.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => void charactersStore.removePersona(persona.id)
    });
  }
</script>

<div class="gallery mx-auto w-full px-6 pb-6" style="max-width: var(--thread-width);">
  <div class="mb-4 flex items-center justify-end gap-2">
    <button type="button" class="aui-btn aui-btn-primary shrink-0" onclick={onnew}>
      <Plus class="size-4" />
      <span>New persona</span>
    </button>
  </div>

  {#if !charactersStore.personas.length}
    <div class="py-14 text-center">
      <p class="text-[15px] font-medium text-foreground">No personas yet</p>
      <p class="mt-1 text-[13px] text-muted-foreground">
        Create one to tell the cast who you are in the story.
      </p>
    </div>
  {:else}
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {#each charactersStore.personas as persona (persona.id)}
        <div class="persona-card group relative">
          <button type="button" class="card-hit flex w-full flex-col items-center gap-2 p-4 text-center" onclick={() => onedit(persona)}>
            <div class="avatar">
              {#if persona.avatar}
                <img src={persona.avatar} alt={persona.name} />
              {:else}
                <span>{persona.name?.trim()?.[0]?.toUpperCase() || '?'}</span>
              {/if}
            </div>
            <div class="min-w-0">
              <div class="truncate text-[14px] font-medium text-foreground">{persona.name}</div>
              {#if persona.description}
                <div class="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{persona.description}</div>
              {/if}
            </div>
            {#if persona.isDefault}
              <span class="tag">Default</span>
            {/if}
          </button>
          <button
            type="button"
            class="edit-btn aui-icon-button absolute right-2 top-2 size-7 opacity-0 transition group-hover:opacity-100"
            onclick={() => onedit(persona)}
            aria-label="Edit persona"
          >
            <Pencil class="size-3.5" />
          </button>
          <button
            type="button"
            class="edit-btn aui-icon-button absolute right-10 top-2 size-7 opacity-0 transition group-hover:opacity-100"
            onclick={() => confirmRemove(persona)}
            aria-label="Delete persona"
          >
            <Trash2 class="size-3.5" />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .persona-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      background-color var(--motion-fast) var(--motion-ease);
  }

  .persona-card:hover {
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

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
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
