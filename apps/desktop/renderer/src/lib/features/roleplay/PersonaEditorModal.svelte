<svelte:options runes={true} />

<!--
  Persona editor: the user's own character in a roleplay.

  Personas are reusable across scenes and worlds; exactly one can be the
  default, which new scenes start with.
-->

<script lang="ts">
  import { deletePersona } from './library-actions.svelte';
  import { untrack } from 'svelte';
  import { X, Upload } from 'lucide-svelte';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { dirtyGuard } from '$lib/components/ui/dirty-guard';
  import { Button, Tooltip } from '$lib/components/ui';
  import type { UserPersona } from '$lib/types/chat';
  import { charactersStore, emptyPersona } from './characters.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    /** null = create a new persona. */
    persona?: UserPersona | null;
    onclose: () => void;
    onsaved?: (persona: UserPersona) => void;
  }

  let { persona = null, onclose, onsaved }: Props = $props();

  // Snapshot once: the modal edits a local copy and only writes on Save.
  let draft = $state<UserPersona>(untrack(() => (persona ? { ...persona } : emptyPersona())));
  // Backdrop, Escape, X and Cancel all ask before throwing edits away.
  const guard = dirtyGuard(() => draft);
  let saving = $state(false);

  const isNew = $derived(!persona);

  function set<K extends keyof UserPersona>(key: K, value: UserPersona[K]) {
    draft = { ...draft, [key]: value };
  }

  function onAvatarPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toastStore.error('Avatar images must be under 2 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set('avatar', String(reader.result || ''));
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!draft.name.trim()) {
      toastStore.error('Give the persona a name first.');
      return;
    }
    saving = true;
    try {
      const saved = await charactersStore.savePersona({ ...draft, name: draft.name.trim() });
      onsaved?.(saved);
      onclose();
    } finally {
      saving = false;
    }
  }
</script>

<div
  class="ui-modal-backdrop"
  role="presentation"
  use:modalLayer={{ onclose: () => guard.close(onclose) }}
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) guard.close(onclose);
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="ui-modal-surface max-w-lg"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="ui-modal-header">
      <div class="min-w-0">
        <div class="ui-modal-title">{isNew ? 'New persona' : draft.name || 'Edit persona'}</div>
        <div class="text-xs text-muted-foreground">Who you are inside the story.</div>
      </div>
      <Tooltip label={copy.actions.close} position="bottom"><button type="button" class="ui-icon-button" onclick={() => guard.close(onclose)} aria-label={copy.actions.close}>
        <X class="size-4" />
      </button></Tooltip>
    </div>

    <div class="ui-modal-body max-h-[62vh] space-y-4 overflow-y-auto">
      <div class="flex items-start gap-4">
        <div class="flex flex-col items-center gap-2">
          <div class="avatar-preview">
            {#if draft.avatar}
              <img src={draft.avatar} alt={draft.name || 'Persona avatar'} />
            {:else}
              <span>{draft.name?.trim()?.[0]?.toUpperCase() || '?'}</span>
            {/if}
          </div>
          <label class="avatar-upload">
            <Upload class="size-3.5" />
            <span>Upload</span>
            <input class="hidden" type="file" accept="image/*" onchange={onAvatarPicked} />
          </label>
        </div>

        <div class="grid min-w-0 flex-1 gap-3">
          <label class="block space-y-1.5 text-sm">
            <span class="font-medium text-muted-foreground">Name</span>
            <input class="ui-input" bind:value={draft.name} placeholder="e.g. Sam" />
          </label>
          <label class="block space-y-1.5 text-sm">
            <span class="font-medium text-muted-foreground">Description</span>
            <textarea
              class="ui-input min-h-24 resize-y"
              bind:value={draft.description}
              placeholder="Who &#123;&#123;user&#125;&#125; is: role, traits, relationship to the cast…"
            ></textarea>
          </label>
        </div>
      </div>

      <div class="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2">
        <div class="min-w-0">
          <div class="text-xs font-medium text-foreground">Default persona</div>
          <div class="text-[12px] text-muted-foreground">New scenes start with this persona selected.</div>
        </div>
        <Button
          type="button"
          size="sm"
          variant={draft.isDefault ? 'default' : 'outline'}
          onclick={() => set('isDefault', !draft.isDefault)}
        >
          {draft.isDefault ? 'Default' : 'Make default'}
        </Button>
      </div>
    </div>

    <div class="ui-modal-footer">
      {#if persona && charactersStore.getPersonaById(persona.id)}
        <!-- Deleting skips the unsaved-changes guard: the item is going away. -->
        <Button variant="outline" size="sm" class="mr-auto text-error" type="button" onclick={() => persona && deletePersona(persona, onclose)}>{copy.actions.delete}</Button>
      {/if}
      <Button variant="outline" size="sm" type="button" onclick={() => guard.close(onclose)}>{copy.actions.cancel}</Button>
      <Button onclick={() => void save()} disabled={saving}>{saving ? 'Saving…' : copy.actions.save}</Button>
    </div>
  </div>
</div>

<style>
  .avatar-preview {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 5rem;
    height: 5rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--muted);
    color: var(--text-muted);
    font-size: 1.5rem;
    font-weight: 600;
  }

  .avatar-preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar-upload {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .avatar-upload:hover {
    background: var(--surface-hover);
  }
</style>
