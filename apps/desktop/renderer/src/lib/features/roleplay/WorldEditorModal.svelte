<svelte:options runes={true} />

<!--
  World editor.

  A world is a reusable scene kit: setting, lorebook, cast, openings and
  defaults. Chats keep their own timeline; this is what carries over.
-->

<script lang="ts">
  import { deleteWorld } from './library-actions.svelte';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import { untrack } from 'svelte';
  import { ArrowDown, ArrowUp, Plus, Trash2, Upload, X } from 'lucide-svelte';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { dirtyGuard } from '$lib/components/ui/dirty-guard';
  import { Button } from '$lib/components/ui';
  import type { CharacterCard, RoleplayWorld } from '$lib/types/chat';
  import { emptyWorld, normalizeWorld, worldsStore } from './worlds.svelte';
  import { charactersStore } from './characters.svelte';
  import LorebookEditor from './LorebookEditor.svelte';
  import RoleplaySettingsEditor from './RoleplaySettingsEditor.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';

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
  let section = $state<'overview' | 'lore' | 'cast' | 'openings' | 'defaults'>('overview');

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
      toastStore.error('Cover images must be under 2 MB.');
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
      toastStore.error('Give the world a name first.');
      section = 'overview';
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

  const sections: Array<{ id: typeof section; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'lore', label: 'Lore' },
    { id: 'cast', label: 'Cast' },
    { id: 'openings', label: 'Openings' },
    { id: 'defaults', label: 'Defaults' }
  ];

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
        <div class="ui-modal-title">{isNew ? 'New world' : draft.name || 'Edit world'}</div>
        <div class="text-xs text-muted-foreground">Setting, canon and cast shared by every scene started here.</div>
      </div>
      <button type="button" class="ui-icon-button" onclick={() => guard.close(onclose)} aria-label={copy.actions.close}>
        <X class="size-4" />
      </button>
    </div>

    <div class="flex gap-1 border-b border-[var(--border-subtle)] px-5 py-2">
      {#each sections as item (item.id)}
        <button
          type="button"
          class="rounded-full px-3 py-1.5 text-[12px] font-medium transition {section === item.id
            ? 'bg-[var(--surface-active)] text-foreground'
            : 'text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground'}"
          onclick={() => (section = item.id)}
        >
          {item.label}
        </button>
      {/each}
    </div>

    <div class="ui-modal-body max-h-[62vh] space-y-4 overflow-y-auto">
      {#if section === 'overview'}
        <div class="flex items-start gap-4">
          <div class="flex flex-col items-center gap-2">
            <div class="cover-preview">
              {#if draft.avatar}
                <img src={draft.avatar} alt={draft.name || 'World cover'} />
              {:else}
                <span>{draft.name?.trim()?.[0]?.toUpperCase() || '?'}</span>
              {/if}
            </div>
            <label class="avatar-upload">
              <Upload class="size-3.5" />
              <span>Cover</span>
              <input class="hidden" type="file" accept="image/*" onchange={onAvatarPicked} />
            </label>
          </div>

          <div class="grid min-w-0 flex-1 gap-3">
            <label class="block space-y-1.5 text-sm">
              <span class="font-medium text-muted-foreground">Name</span>
              <input class="ui-input" bind:value={draft.name} placeholder="e.g. Eldoria" />
            </label>
            <label class="block space-y-1.5 text-sm">
              <span class="font-medium text-muted-foreground">Tagline</span>
              <input class="ui-input" bind:value={draft.tagline} placeholder="One line shown in the gallery" />
            </label>
          </div>
        </div>

        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">Overview</span>
          <span class="block text-xs text-muted-foreground">Always present in the prompt: setting, rules, tone.</span>
          <textarea class="ui-input min-h-28 resize-y" bind:value={draft.overview} placeholder="A floating city above a drowned world…"></textarea>
        </label>
        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">Scenario</span>
          <span class="block text-xs text-muted-foreground">Used when the primary character defines no scenario of their own.</span>
          <textarea class="ui-input min-h-20 resize-y" bind:value={draft.scenario} placeholder="The festival of lanterns begins tonight…"></textarea>
        </label>
      {/if}

      {#if section === 'lore'}
        <LorebookEditor book={draft.book} onchange={(book) => set('book', book)} />
      {/if}

      {#if section === 'cast'}
        <div class="space-y-2">
          <div class="text-sm font-medium text-muted-foreground">Cast order</div>
          {#if !cast.length}
            <p class="rounded-[var(--radius-md)] border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-muted-foreground">
              No cast yet. Add characters below — the first one opens scenes.
            </p>
          {:else}
            {#each cast as card, index (card.id)}
              <div class="cast-row">
                <span class="cast-order">{index + 1}</span>
                <span class="cast-avatar">
                  <Avatar size="fill" name={card.name ?? ''} image={card.avatar} />
                </span>
                <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{card.name}</span>
                <button type="button" class="ui-icon-button is-sm" disabled={index === 0} onclick={() => moveCast(index, -1)} aria-label="Move up">
                  <ArrowUp class="size-3.5" />
                </button>
                <button type="button" class="ui-icon-button is-sm" disabled={index === cast.length - 1} onclick={() => moveCast(index, 1)} aria-label="Move down">
                  <ArrowDown class="size-3.5" />
                </button>
                <button type="button" class="ui-icon-button is-sm text-error" onclick={() => removeFromCast(card.id)} aria-label="Remove from cast">
                  <X class="size-3.5" />
                </button>
              </div>
            {/each}
          {/if}
        </div>

        {#if available.length}
          <div class="space-y-2">
            <div class="text-sm font-medium text-muted-foreground">Add from your library</div>
            <div class="flex flex-wrap gap-1.5">
              {#each available as card (card.id)}
                <button type="button" class="cast-add" onclick={() => addToCast(card.id)}>
                  <Plus class="size-3" />
                  <span class="truncate">{card.name}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      {/if}

      {#if section === 'openings'}
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <div class="min-w-0">
              <div class="text-sm font-medium text-muted-foreground">Openings</div>
              <div class="text-xs text-muted-foreground">Scenes can start with one of these instead of a character greeting.</div>
            </div>
            <button type="button" class="ui-btn ui-btn-ghost shrink-0" onclick={addStarter}>
              <Plus class="size-3.5" /> Add
            </button>
          </div>
          {#if !draft.starters.length}
            <p class="rounded-[var(--radius-md)] border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-muted-foreground">
              No openings yet. Add one to set the scene before anyone speaks.
            </p>
          {:else}
            {#each draft.starters as starter, index (index)}
              <div class="flex items-start gap-2">
                <textarea
                  class="ui-input min-h-16 flex-1 resize-y"
                  value={starter}
                  oninput={(e) => updateStarter(index, e.currentTarget.value)}
                  placeholder="The lanterns rise over the harbor as…"
                ></textarea>
                <button type="button" class="ui-icon-button mt-1 text-error" onclick={() => removeStarter(index)} aria-label="Remove opening">
                  <Trash2 class="size-4" />
                </button>
              </div>
            {/each}
          {/if}
        </div>
      {/if}

      {#if section === 'defaults'}
        <RoleplaySettingsEditor value={draft.settings ?? {}} onchange={(next) => set('settings', next)} />
      {/if}
    </div>

    <div class="ui-modal-footer">
      {#if world && worldsStore.getById(world.id)}
        <!-- Deleting skips the unsaved-changes guard: the item is going away. -->
        <button type="button" class="ui-btn ui-btn-ghost mr-auto text-error" onclick={() => world && deleteWorld(world, onclose)}>{copy.actions.delete}</button>
      {/if}
      <button type="button" class="ui-btn ui-btn-ghost" onclick={() => guard.close(onclose)}>{copy.actions.cancel}</button>
      <Button onclick={() => void save()} disabled={saving}>{saving ? 'Saving…' : copy.actions.save}</Button>
    </div>
  </div>
</div>

<style>
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
    font-size: 0.6875rem;
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
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .cast-add {
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

  .cast-add:hover {
    border-color: var(--border-hover);
    color: var(--foreground);
  }
</style>
