<svelte:options runes={true} />

<!--
  World editor.

  A world is a reusable scene kit: setting, lorebook, cast, openings and
  defaults. Chats keep their own timeline; this is what carries over.
-->

<script lang="ts">
  import DialogActions from '$lib/components/ui/DialogActions.svelte';

  import DialogFooter from '$lib/components/ui/DialogFooter.svelte';

  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiFileInput from '$lib/components/ui/FileInput.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { deleteWorld } from './library-actions.svelte';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import { untrack } from 'svelte';
  import { ArrowDown, ArrowUp, Plus, Trash2, Upload, X } from '$lib/icons';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { dirtyGuard } from '$lib/components/ui/dirty-guard';
  import { Button, Tooltip } from '$lib/components/ui';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import type { CharacterCard, RoleplayWorld } from '$lib/types/chat';
  import { emptyWorld, normalizeWorld, worldsStore } from './worlds.svelte';
  import { charactersStore } from './characters.svelte';
  import LorebookEditor from './LorebookEditor.svelte';
  import RoleplaySettingsEditor from './RoleplaySettingsEditor.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import MacroField from './MacroField.svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    /** null = create a new world. */
    world?: RoleplayWorld | null;
    onclose: () => void;
    onsaved?: (world: RoleplayWorld) => void;
  }

  let { world = null, onclose, onsaved }: Props = $props();

  let draft = $state<RoleplayWorld>(untrack(() => (world ? normalizeWorld(world) : emptyWorld())));
  // Backdrop, Escape, X and Cancel all ask before throwing edits away.
  const guard = dirtyGuard(() => draft);
  let saving = $state(false);
  let section = $state<'basics' | 'cast' | 'openings' | 'lore' | 'defaults'>('basics');
  const userName = $derived($t('roleplay.you'));

  const isNew = $derived(!world);
  const cast = $derived(
    draft.castIds
      .map((id) => charactersStore.getById(id))
      .filter((card): card is CharacterCard => !!card)
  );
  const available = $derived(charactersStore.characters.filter((card) => !draft.castIds.includes(card.id)));

  function set<K extends keyof RoleplayWorld>(key: K, value: RoleplayWorld[K]) {
    draft = { ...draft, [key]: value };
  }

  function onAvatarPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toastStore.error($t('roleplay.world.coverTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set('avatar', String(reader.result || ''));
    reader.readAsDataURL(file);
  }

  function addToCast(id: string) {
    if (draft.castIds.includes(id)) return;
    set('castIds', [...draft.castIds, id]);
  }

  function removeFromCast(id: string) {
    set('castIds', draft.castIds.filter((entry) => entry !== id));
  }

  function moveCast(index: number, direction: -1 | 1) {
    const next = [...draft.castIds];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    set('castIds', next);
  }

  function updateStarter(index: number, value: string) {
    const next = [...draft.starters];
    next[index] = value;
    set('starters', next);
  }

  function addStarter() {
    set('starters', [...draft.starters, '']);
  }

  function removeStarter(index: number) {
    set('starters', draft.starters.filter((_, i) => i !== index));
  }

  async function save() {
    if (!draft.name.trim()) {
      toastStore.error($t('roleplay.world.nameRequired'));
      section = 'basics';
      return;
    }
    saving = true;
    try {
      const saved = await worldsStore.save({ ...draft, name: draft.name.trim() });
      onsaved?.(saved);
      onclose();
    } finally {
      saving = false;
    }
  }

  const sections = $derived<Array<{ value: typeof section; label: string }>>([
    { value: 'basics', label: $t('roleplay.world.tab.basics') },
    { value: 'cast', label: $t('roleplay.world.tab.cast') },
    { value: 'openings', label: $t('roleplay.world.tab.openings') },
    { value: 'lore', label: $t('roleplay.world.tab.lore') },
    { value: 'defaults', label: $t('roleplay.world.tab.defaults') }
  ]);

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
    class="ui-modal-surface max-w-3xl"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="ui-modal-header">
      <div class="min-w-0">
        <div class="ui-modal-title">{isNew ? $t('roleplay.world.newTitle') : draft.name || $t('roleplay.world.editTitle')}</div>
        <div class="text-xs text-muted-foreground">{$t('roleplay.world.subtitle')}</div>
      </div>
      <Tooltip label={copy.actions.close} position="bottom"><UiIconButton label={copy.actions.close} size="sm" type="button" class={uiClass("", "ui-local-8924758d")} onclick={() => guard.close(onclose)} >
        <X class="size-4" />
      </UiIconButton></Tooltip>
    </div>

    <div class="tabs-row">
      <SegmentedControl value={section} options={sections} label={$t('roleplay.world.title')} variant="tabs" shape="rect" onchange={(value) => (section = value as typeof section)} />
    </div>

    <div class="ui-modal-body max-h-[62vh] space-y-4 overflow-y-auto">
      {#if section === 'basics'}
        <div class="flex items-start gap-4">
          <div class="flex flex-col items-center gap-2">
            <div class="cover-preview">
              {#if draft.avatar}
                <img src={draft.avatar} alt={draft.name || $t('roleplay.world.cover')} />
              {:else}
                <span>{draft.name?.trim()?.[0]?.toUpperCase() || '?'}</span>
              {/if}
            </div>
            <label class="avatar-upload">
              <Upload class="size-3.5" />
              <span>{$t('roleplay.world.cover')}</span>
              <UiFileInput class={uiClass("hidden", "ui-local-8924758d")}  accept="image/*" onchange={onAvatarPicked} />
            </label>
          </div>

          <div class="grid min-w-0 flex-1 gap-3">
            <label class="block space-y-1.5 text-sm">
              <span class="font-medium text-muted-foreground">{$t('roleplay.world.name')}</span>
              <UiInput class={uiClass("", "ui-local-8924758d")} bind:value={draft.name} placeholder={$t('roleplay.world.namePlaceholder')} />
            </label>
            <label class="block space-y-1.5 text-sm">
              <span class="font-medium text-muted-foreground">{$t('roleplay.character.tagline')}</span>
              <UiInput class={uiClass("", "ui-local-8924758d")} bind:value={draft.tagline} placeholder={$t('roleplay.world.taglinePlaceholder')} />
            </label>
          </div>
        </div>

        <MacroField
          label={$t('roleplay.world.overview')}
          hint={$t('roleplay.world.overviewHint')}
          value={draft.overview}
          char={$t('roleplay.world.charPreview')}
          user={userName}
          rows={5}
          placeholder={$t('roleplay.world.overviewPlaceholder')}
          onchange={(value) => set('overview', value)}
        />
        <MacroField
          label={$t('roleplay.world.scenario')}
          hint={$t('roleplay.world.scenarioHint')}
          value={draft.scenario ?? ''}
          char={$t('roleplay.world.charPreview')}
          user={userName}
          rows={3}
          placeholder={$t('roleplay.world.scenarioPlaceholder')}
          onchange={(value) => set('scenario', value)}
        />
      {/if}

      {#if section === 'lore'}
        <LorebookEditor book={draft.book} onchange={(book) => set('book', book)} heightClass="h-[46vh]" />
      {/if}

      {#if section === 'cast'}
        <div class="space-y-2">
          <div class="text-sm font-medium text-muted-foreground">{$t('roleplay.world.castOrder')}</div>
          {#if !cast.length}
            <p class="py-2 text-xs text-muted-foreground">{$t('roleplay.world.castEmpty')}</p>
          {:else}
            {#each cast as card, index (card.id)}
              <div class="cast-row">
                <span class="cast-order">{index + 1}</span>
                <span class="cast-avatar">
                  <Avatar size="fill" name={card.name ?? ''} image={card.avatar} />
                </span>
                <span class="min-w-0 flex-1 truncate text-[length:var(--text-sm)] text-foreground">{card.name}</span>
                <Tooltip label={$t('roleplay.world.moveUp')} position="bottom"><UiIconButton label={$t('roleplay.world.moveUp')} size="xs" type="button" class={uiClass(" ", "ui-local-8924758d")} disabled={index === 0} onclick={() => moveCast(index, -1)} >
                  <ArrowUp class="size-3.5" />
                </UiIconButton></Tooltip>
                <Tooltip label={$t('roleplay.world.moveDown')} position="bottom"><UiIconButton label={$t('roleplay.world.moveDown')} size="xs" type="button" class={uiClass(" ", "ui-local-8924758d")} disabled={index === cast.length - 1} onclick={() => moveCast(index, 1)} >
                  <ArrowDown class="size-3.5" />
                </UiIconButton></Tooltip>
                <Tooltip label={$t('roleplay.world.removeFromCast')} position="bottom"><UiIconButton label={$t('roleplay.world.removeFromCast')} size="xs" type="button" class={uiClass("  hover:text-error", "ui-local-8924758d")} onclick={() => removeFromCast(card.id)} >
                  <X class="size-3.5" />
                </UiIconButton></Tooltip>
              </div>
            {/each}
          {/if}
        </div>

        {#if available.length}
          <div class="space-y-2">
            <div class="text-sm font-medium text-muted-foreground">{$t('roleplay.world.addFromLibrary')}</div>
            <div class="flex flex-wrap gap-1.5">
              {#each available as card (card.id)}
                <Button variant="plain" type="button" class={uiClass("cast-add", "ui-local-8924758d")} onclick={() => addToCast(card.id)}>
                  <Plus class="size-3" />
                  <span class="truncate">{card.name}</span>
                </Button>
              {/each}
            </div>
          </div>
        {/if}
      {/if}

      {#if section === 'openings'}
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <div class="min-w-0">
              <div class="text-sm font-medium text-muted-foreground">{$t('roleplay.world.tab.openings')}</div>
              <div class="text-xs text-muted-foreground">{$t('roleplay.world.openingsHint')}</div>
            </div>
            <Button variant="outline" size="sm" class="shrink-0" type="button" onclick={addStarter}>
              <Plus class="size-3.5" /> {$t('roleplay.character.addOpening')}
            </Button>
          </div>
          {#if !draft.starters.length}
            <p class="py-2 text-xs text-muted-foreground">{$t('roleplay.world.openingsEmpty')}</p>
          {:else}
            {#each draft.starters as starter, index (index)}
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <MacroField
                    label={$t('roleplay.character.openingN', { values: { n: index + 1 } })}
                    value={starter}
                    char={$t('roleplay.world.charPreview')}
                    user={userName}
                    rows={3}
                    placeholder={$t('roleplay.world.openingPlaceholder')}
                    onchange={(value) => updateStarter(index, value)}
                  />
                </div>
                <Tooltip label={$t('roleplay.character.removeOpening')} position="bottom"><UiIconButton label={$t('roleplay.character.removeOpening')} size="sm" type="button" class={uiClass(" mt-6 hover:text-error", "ui-local-8924758d")} onclick={() => removeStarter(index)} >
                  <Trash2 class="size-4" />
                </UiIconButton></Tooltip>
              </div>
            {/each}
          {/if}
        </div>
      {/if}

      {#if section === 'defaults'}
        <RoleplaySettingsEditor value={draft.settings ?? {}} onchange={(next) => set('settings', next)} />
      {/if}
    </div>

    <DialogFooter >
      {#if world && worldsStore.getById(world.id)}
        <!-- Deleting skips the unsaved-changes guard: the item is going away. -->
        <Button variant="outline" size="sm" class="mr-auto hover:text-error" type="button" onclick={() => world && deleteWorld(world, onclose)}>{copy.actions.delete}</Button>
      {/if}
      <DialogActions cancelLabel={copy.actions.cancel} confirmLabel={saving ? $t('roleplay.saving') : copy.actions.save} oncancel={() => guard.close(onclose)} onconfirm={() => void save()} busy={saving} />
    </DialogFooter>
  </div>
</div>

<style>
  .tabs-row {
    padding: 0.5rem 1.25rem 0.25rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .cover-preview {
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

  .cover-preview img {
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

  .cast-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
  }

  .cast-order {
    width: 1.125rem;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .cast-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    overflow: hidden;
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  :global(.cast-add.ui-local-8924758d) {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    max-width: 12rem;
    padding: 0.25rem 0.625rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-full);
    color: var(--text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  :global(.cast-add:hover.ui-local-8924758d) {
    border-color: var(--border-hover);
    color: var(--foreground);
  }
</style>
