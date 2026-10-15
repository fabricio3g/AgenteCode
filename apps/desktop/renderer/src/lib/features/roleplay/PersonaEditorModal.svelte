<svelte:options runes={true} />

<!--
  Persona editor: the user's own character in a roleplay.

  Personas are reusable across scenes and worlds; exactly one can be the
  default, which new scenes start with.
-->

<script lang="ts">
  import DialogActions from '$lib/components/ui/DialogActions.svelte';

  import DialogFooter from '$lib/components/ui/DialogFooter.svelte';

  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiFileInput from '$lib/components/ui/FileInput.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

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
  import MacroField from './MacroField.svelte';
  import { t } from 'svelte-i18n';

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
      toastStore.error($t('roleplay.character.avatarTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set('avatar', String(reader.result || ''));
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!draft.name.trim()) {
      toastStore.error($t('roleplay.persona.nameRequired'));
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
        <div class="ui-modal-title">{isNew ? $t('roleplay.persona.newTitle') : draft.name || $t('roleplay.persona.editTitle')}</div>
        <div class="text-xs text-muted-foreground">{$t('roleplay.persona.subtitle')}</div>
      </div>
      <Tooltip label={copy.actions.close} position="bottom"><UiIconButton label={copy.actions.close} size="sm" type="button"  onclick={() => guard.close(onclose)} >
        <X class="size-4" />
      </UiIconButton></Tooltip>
    </div>

    <div class="ui-modal-body max-h-[62vh] space-y-4 overflow-y-auto">
      <div class="flex items-start gap-4">
        <div class="flex flex-col items-center gap-2">
          <div class="avatar-preview">
            {#if draft.avatar}
              <img src={draft.avatar} alt={draft.name || $t('roleplay.persona.avatar')} />
            {:else}
              <span>{draft.name?.trim()?.[0]?.toUpperCase() || '?'}</span>
            {/if}
          </div>
          <label class="avatar-upload">
            <Upload class="size-3.5" />
            <span>{$t('roleplay.character.upload')}</span>
            <UiFileInput class={uiClass("hidden")}  accept="image/*" onchange={onAvatarPicked} />
          </label>
        </div>

        <div class="grid min-w-0 flex-1 gap-3">
          <label class="block space-y-1.5 text-sm">
            <span class="font-medium text-muted-foreground">{$t('roleplay.persona.name')}</span>
            <UiInput  bind:value={draft.name} placeholder={$t('roleplay.persona.namePlaceholder')} />
          </label>
          <MacroField
            label={$t('roleplay.persona.description')}
            hint={$t('roleplay.persona.descriptionHint')}
            value={draft.description}
            char={$t('roleplay.persona.charPreview')}
            user={draft.name?.trim() || $t('roleplay.you')}
            rows={4}
            placeholder={$t('roleplay.persona.descriptionPlaceholder')}
            onchange={(value) => set('description', value)}
          />
        </div>
      </div>

      <div class="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2">
        <div class="min-w-0">
          <div class="text-xs font-medium text-foreground">{$t('roleplay.persona.default')}</div>
          <div class="text-[length:var(--text-xs)] text-muted-foreground">{$t('roleplay.persona.defaultHint')}</div>
        </div>
        <Button
          type="button"
          size="sm"
          variant={draft.isDefault ? 'default' : 'outline'}
          onclick={() => set('isDefault', !draft.isDefault)}
        >
          {draft.isDefault ? $t('roleplay.persona.isDefault') : $t('roleplay.persona.makeDefault')}
        </Button>
      </div>
    </div>

    <DialogFooter >
      {#if persona && charactersStore.getPersonaById(persona.id)}
        <!-- Deleting skips the unsaved-changes guard: the item is going away. -->
        <Button variant="outline" size="sm" class="mr-auto hover:text-error" type="button" onclick={() => persona && deletePersona(persona, onclose)}>{copy.actions.delete}</Button>
      {/if}
      <DialogActions cancelLabel={copy.actions.cancel} confirmLabel={saving ? $t('roleplay.saving') : copy.actions.save} oncancel={() => guard.close(onclose)} onconfirm={() => void save()} busy={saving} />
    </DialogFooter>
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
