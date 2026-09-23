<svelte:options runes={true} />

<!--
  World editor.

  A world is a reusable scene kit: setting, lorebook, cast, openings and
  defaults. Chats keep their own timeline; this is what carries over.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { ArrowDown, ArrowUp, Plus, Trash2, Upload, X } from 'lucide-svelte';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { dirtyGuard } from '$lib/components/ui/dirty-guard';
  import { Button, Select, Switch } from '$lib/components/ui';
  import type { CharacterCard, RoleplayWorld } from '$lib/types/chat';
  import { emptyWorld, normalizeWorld, worldsStore } from './worlds.svelte';
  import { charactersStore } from './characters.svelte';
  import LorebookEditor from './LorebookEditor.svelte';
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

  function setSetting<K extends keyof NonNullable<RoleplayWorld['settings']>>(
    key: K,
    value: NonNullable<RoleplayWorld['settings']>[K]
  ) {
    set('settings', { ...(draft.settings || {}), [key]: value });
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

  function numberValue(event: Event): number | null {
    const raw = (event.currentTarget as HTMLInputElement).value.trim();
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
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

  const replyOrderOptions = [
    { value: 'list', label: 'List order — take turns in cast order' },
    { value: 'natural', label: 'Natural — mentions, then talkativeness' },
    { value: 'mention', label: 'Mentions only' },
    { value: 'manual', label: 'Manual — pick each speaker' }
  ];

  const ratingOptions = [
    { value: 'sfw', label: 'Safe for work' },
    { value: 'unrestricted', label: 'Unrestricted' }
  ];
</script>

<div
  class="aui-modal-backdrop"
  role="presentation"
  use:modalLayer={{ onclose: () => guard.close(onclose) }}
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) guard.close(onclose);
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="aui-modal-surface max-w-3xl"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="aui-modal-header">
      <div class="min-w-0">
        <div class="aui-modal-title">{isNew ? 'New world' : draft.name || 'Edit world'}</div>
        <div class="text-xs text-muted-foreground">Setting, canon and cast shared by every scene started here.</div>
      </div>
      <button type="button" class="aui-icon-button size-8" onclick={() => guard.close(onclose)} aria-label={copy.actions.close}>
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

    <div class="aui-modal-body max-h-[62vh] space-y-4 overflow-y-auto">
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
              <input class="aui-input" bind:value={draft.name} placeholder="e.g. Eldoria" />
            </label>
            <label class="block space-y-1.5 text-sm">
              <span class="font-medium text-muted-foreground">Tagline</span>
              <input class="aui-input" bind:value={draft.tagline} placeholder="One line shown in the gallery" />
            </label>
          </div>
        </div>

        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">Overview</span>
          <span class="block text-xs text-muted-foreground">Always present in the prompt: setting, rules, tone.</span>
          <textarea class="aui-input min-h-28 resize-y" bind:value={draft.overview} placeholder="A floating city above a drowned world…"></textarea>
        </label>
        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">Scenario</span>
          <span class="block text-xs text-muted-foreground">Used when the primary character defines no scenario of their own.</span>
          <textarea class="aui-input min-h-20 resize-y" bind:value={draft.scenario} placeholder="The festival of lanterns begins tonight…"></textarea>
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
                  {#if card.avatar}
                    <img src={card.avatar} alt={card.name} />
                  {:else}
                    <span>{card.name?.trim()?.[0]?.toUpperCase() || '?'}</span>
                  {/if}
                </span>
                <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{card.name}</span>
                <button type="button" class="aui-icon-button size-7" disabled={index === 0} onclick={() => moveCast(index, -1)} aria-label="Move up">
                  <ArrowUp class="size-3.5" />
                </button>
                <button type="button" class="aui-icon-button size-7" disabled={index === cast.length - 1} onclick={() => moveCast(index, 1)} aria-label="Move down">
                  <ArrowDown class="size-3.5" />
                </button>
                <button type="button" class="aui-icon-button size-7 text-error" onclick={() => removeFromCast(card.id)} aria-label="Remove from cast">
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
            <button type="button" class="aui-btn aui-btn-ghost shrink-0" onclick={addStarter}>
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
                  class="aui-input min-h-16 flex-1 resize-y"
                  value={starter}
                  oninput={(e) => updateStarter(index, e.currentTarget.value)}
                  placeholder="The lanterns rise over the harbor as…"
                ></textarea>
                <button type="button" class="aui-icon-button size-8 mt-1 text-error" onclick={() => removeStarter(index)} aria-label="Remove opening">
                  <Trash2 class="size-4" />
                </button>
              </div>
            {/each}
          {/if}
        </div>
      {/if}

      {#if section === 'defaults'}
        <div class="space-y-1.5">
          <span class="text-sm font-medium text-muted-foreground">Speaker order</span>
          <Select
            variant="surface"
            value={draft.settings?.replyOrder || 'list'}
            options={replyOrderOptions}
            aria-label="Speaker order"
            onchange={(value) => setSetting('replyOrder', value as NonNullable<RoleplayWorld['settings']>['replyOrder'])}
          />
        </div>

        <div class="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2">
          <div class="min-w-0">
            <div class="text-xs font-medium text-foreground">Auto mode</div>
            <div class="text-[11px] text-muted-foreground">Characters keep talking without a user turn until paused.</div>
          </div>
          <Switch
            checked={!!draft.settings?.autoMode}
            label="Auto mode"
            onchange={(checked) => setSetting('autoMode', checked)}
          />
        </div>

        <div class="space-y-1.5">
          <span class="text-sm font-medium text-muted-foreground">Pause between auto turns</span>
          <Select
            variant="surface"
            value={String(draft.settings?.autoModeDelayMs ?? 8000)}
            options={[
              { value: '2000', label: '2 seconds' },
              { value: '4000', label: '4 seconds' },
              { value: '8000', label: '8 seconds' },
              { value: '12000', label: '12 seconds' }
            ]}
            aria-label="Pause between auto turns"
            onchange={(value) => setSetting('autoModeDelayMs', Number(value) || 8000)}
          />
        </div>

        <div class="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2">
          <div class="min-w-0">
            <div class="text-xs font-medium text-foreground">Adventure choices</div>
            <div class="text-[11px] text-muted-foreground">Replies end with clickable suggested actions.</div>
          </div>
          <Switch
            checked={!!draft.settings?.adventureChoices}
            label="Adventure choices"
            onchange={(checked) => setSetting('adventureChoices', checked)}
          />
        </div>

        <div class="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2">
          <div class="min-w-0">
            <div class="text-xs font-medium text-foreground">Show speaker labels</div>
            <div class="text-[11px] text-muted-foreground">Keep the "Name:" prefix the model writes in replies.</div>
          </div>
          <Switch
            checked={!!draft.settings?.showSpeakerLabels}
            label="Show speaker labels"
            onchange={(checked) => setSetting('showSpeakerLabels', checked)}
          />
        </div>

        <div class="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2">
          <div class="min-w-0">
            <div class="text-xs font-medium text-foreground">Let characters write each other</div>
            <div class="text-[11px] text-muted-foreground">One generation may voice several cast members.</div>
          </div>
          <Switch
            checked={!!draft.settings?.allowMultiSpeaker}
            label="Let characters write each other"
            onchange={(checked) => setSetting('allowMultiSpeaker', checked)}
          />
        </div>

        <div class="grid gap-3 sm:grid-cols-3">
          <label class="block space-y-1.5 text-sm">
            <span class="text-xs font-medium text-muted-foreground">Auto turns before pause</span>
            <input
              class="aui-input"
              type="number"
              min="1"
              max="12"
              value={draft.settings?.autoModeMaxTurns ?? 4}
              oninput={(event) => setSetting('autoModeMaxTurns', numberValue(event) ?? 4)}
            />
          </label>
          <label class="block space-y-1.5 text-sm">
            <span class="text-xs font-medium text-muted-foreground">Temperature</span>
            <input class="aui-input" type="number" step="0.01" value={draft.settings?.temperature ?? ''} oninput={(event) => setSetting('temperature', numberValue(event))} placeholder="Model default" />
          </label>
          <label class="block space-y-1.5 text-sm">
            <span class="text-xs font-medium text-muted-foreground">Top P</span>
            <input class="aui-input" type="number" step="0.01" value={draft.settings?.topP ?? ''} oninput={(event) => setSetting('topP', numberValue(event))} placeholder="Model default" />
          </label>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block space-y-1.5 text-sm">
            <span class="text-xs font-medium text-muted-foreground">Max tokens</span>
            <input class="aui-input" type="number" min="0" value={draft.settings?.maxTokens ?? ''} oninput={(event) => setSetting('maxTokens', numberValue(event))} placeholder="Model default" />
          </label>
          <div class="space-y-1.5">
            <span class="text-xs font-medium text-muted-foreground">Content rating</span>
            <Select
              variant="surface"
              value={draft.settings?.contentRating || 'sfw'}
              options={ratingOptions}
              aria-label="Content rating"
              onchange={(value) => setSetting('contentRating', value as 'sfw' | 'unrestricted')}
            />
          </div>
        </div>

        <label class="block space-y-1.5 text-sm">
          <span class="text-xs font-medium text-muted-foreground">Author's note</span>
          <textarea class="aui-input min-h-16 resize-y" value={draft.settings?.authorNote || ''} oninput={(event) => setSetting('authorNote', event.currentTarget.value)} placeholder="Tone, pacing, or a rule for every reply."></textarea>
        </label>
      {/if}
    </div>

    <div class="aui-modal-footer">
      <button type="button" class="aui-btn aui-btn-ghost" onclick={() => guard.close(onclose)}>{copy.actions.cancel}</button>
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

  .cast-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
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
