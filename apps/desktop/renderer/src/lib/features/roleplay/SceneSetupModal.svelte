<svelte:options runes={true} />

<!--
  Scene setup.

  Turns a world (or a bare character) into a concrete scene: choose the cast,
  the persona, and the opening line. The first cast member is the primary
  speaker; two or more make it a group scene.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { Globe2, X } from 'lucide-svelte';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { Button, Select } from '$lib/components/ui';
  import type { CharacterCard, RoleplaySettings, RoleplayWorld } from '$lib/types/chat';
  import RoleplaySettingsEditor from './RoleplaySettingsEditor.svelte';
  import { roleplayPreferences } from './roleplay-presets.svelte';
  import { resolveRoleplaySettings } from './roleplay-settings';
  import { charactersStore, greetingsFor } from './characters.svelte';
  import CastPicker from './CastPicker.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    world?: RoleplayWorld | null;
    /** Quick start from a character card; preselected in the cast. */
    initialCharacter?: CharacterCard | null;
    onclose: () => void;
    onstart: (config: {
      characters: CharacterCard[];
      world: RoleplayWorld | null;
      personaId: string | null;
      openingSource: 'greeting' | 'starter' | 'none';
      openingIndex: number;
      settings: RoleplaySettings;
    }) => void;
  }

  let { world = null, initialCharacter = null, onclose, onstart }: Props = $props();

  const initialCast = untrack(() => {
    const fromWorld = (world?.castIds || []).filter((id) => charactersStore.getById(id));
    if (fromWorld.length) return fromWorld;
    return initialCharacter ? [initialCharacter.id] : [];
  });

  let castIds = $state<string[]>(initialCast);
  let personaId = $state<string>(
    untrack(() => world?.defaultPersonaId || charactersStore.defaultPersona?.id || '')
  );
  let openingKey = $state<string>('0');
  let sceneSettings = $state<RoleplaySettings>({});
  roleplayPreferences.load();
  const inherited = $derived(resolveRoleplaySettings(roleplayPreferences.defaults, world?.settings));

  const cast = $derived(castIds.map((id) => charactersStore.getById(id)).filter((card): card is CharacterCard => !!card));
  const primary = $derived(cast[0] || null);
  const group = $derived(cast.length > 1);

  /** Openings: the world's starters and the primary's greetings, plus "none". */
  const openings = $derived.by(() => {
    const list: Array<{ key: string; source: 'starter' | 'greeting' | 'none'; index: number; text: string }> = [];
    const starters = (world?.starters || []).filter((text) => text.trim());
    starters.forEach((text, index) => {
      list.push({ key: `starter:${index}`, source: 'starter', index, text });
    });
    if (primary) {
      greetingsFor(primary, { group }).forEach((text, index) => {
        list.push({ key: `greeting:${index}`, source: 'greeting', index, text });
      });
    }
    list.push({ key: 'none', source: 'none', index: -1, text: '' });
    return list;
  });

  const worldOpenings = $derived(openings.filter((opening) => opening.source === 'starter'));
  const greetingOpenings = $derived(openings.filter((opening) => opening.source === 'greeting'));
  const noOpening = $derived(openings.find((opening) => opening.source === 'none')!);

  const selectedOpening = $derived(openings.find((opening) => opening.key === openingKey) || openings[0] || null);

  const personaOptions = $derived([
    { value: '', label: 'No persona' },
    ...charactersStore.personas.map((persona) => ({ value: persona.id, label: persona.name }))
  ]);

  function start() {
    if (!primary || !selectedOpening) return;
    onstart({
      characters: cast,
      world,
      personaId: personaId || null,
      openingSource: selectedOpening.source,
      openingIndex: selectedOpening.index,
      settings: sceneSettings
    });
  }</script>

<div
  class="ui-modal-backdrop"
  role="presentation"
  use:modalLayer={{ onclose: onclose }}
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="ui-modal-surface max-w-2xl"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="ui-modal-header">
      <div class="min-w-0">
        <div class="ui-modal-title">{world ? world.name : 'New scene'}</div>
        <div class="text-xs text-muted-foreground">
          {group ? `Group scene · ${cast.length} characters` : 'One-on-one scene'}
          {world ? ' · world canon active' : ''}
        </div>
      </div>
      <button type="button" class="ui-icon-button" onclick={onclose} aria-label={copy.actions.close}>
        <X class="size-4" />
      </button>
    </div>

    <div class="ui-modal-body max-h-[64vh] space-y-5 overflow-y-auto">
      <details><summary class="cursor-pointer text-sm text-muted-foreground">Conversation settings · Chat / Dynamic</summary><div class="pt-4"><RoleplaySettingsEditor value={sceneSettings} {inherited} onchange={(next) => (sceneSettings = next)} /></div></details>
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-muted-foreground">Cast</span>
          {#if cast.length}
            <span class="text-[11px] text-muted-foreground">First speaks first</span>
          {/if}
        </div>
        <CastPicker value={castIds} onchange={(ids) => (castIds = ids)} />
      </div>

      <div class="space-y-1.5">
        <span class="text-sm font-medium text-muted-foreground">Your persona</span>
        <Select
          variant="surface"
          value={personaId}
          options={personaOptions}
          aria-label="Your persona"
          onchange={(value) => (personaId = value)}
        />
      </div>

      <div class="space-y-3">
        <span class="text-sm font-medium text-muted-foreground">Opening</span>
        {#if worldOpenings.length}
          <div class="space-y-1.5">
            <span class="text-[11px] text-muted-foreground">World openings</span>
            {#each worldOpenings as opening (opening.key)}
              <button
                type="button"
                class="opening-option {selectedOpening?.key === opening.key ? 'is-on' : ''}"
                onclick={() => (openingKey = opening.key)}
                aria-pressed={selectedOpening?.key === opening.key}
              >
                <span class="opening-source"><Globe2 class="size-3" /></span>
                <span class="line-clamp-3 text-left text-[12px] text-foreground">{opening.text}</span>
              </button>
            {/each}
          </div>
        {/if}
        {#if greetingOpenings.length}
          <div class="space-y-1.5">
            <span class="text-[11px] text-muted-foreground">{primary?.name || 'Character'} greetings</span>
            {#each greetingOpenings as opening (opening.key)}
              <button
                type="button"
                class="opening-option {selectedOpening?.key === opening.key ? 'is-on' : ''}"
                onclick={() => (openingKey = opening.key)}
                aria-pressed={selectedOpening?.key === opening.key}
              >
                <span class="opening-source"><span class="opening-index">{opening.index + 1}</span></span>
                <span class="line-clamp-3 text-left text-[12px] text-foreground">{opening.text}</span>
              </button>
            {/each}
          </div>
        {/if}
        <button
          type="button"
          class="opening-option {selectedOpening?.source === 'none' ? 'is-on' : ''}"
          onclick={() => (openingKey = noOpening.key)}
          aria-pressed={selectedOpening?.source === 'none'}
        >
          <span class="opening-source"><X class="size-3" /></span>
          <span class="text-left text-[12px] text-muted-foreground">No opening — start with your first message</span>
        </button>
      </div>
    </div>

    <div class="ui-modal-footer">
      <button type="button" class="ui-btn ui-btn-ghost" onclick={onclose}>{copy.actions.cancel}</button>
      <Button onclick={start} disabled={!primary}>{group ? 'Start group scene' : 'Start scene'}</Button>
    </div>
  </div>
</div>

<style>
  .opening-option {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
    cursor: pointer;
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      background-color var(--motion-fast) var(--motion-ease);
  }

  .opening-option:hover {
    background: var(--surface-hover);
  }

  .opening-option.is-on {
    border-color: var(--border-hover);
    background: var(--surface-active);
  }

  .opening-source {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    height: 1.125rem;
    flex-shrink: 0;
    margin-top: 0.0625rem;
    color: var(--text-muted);
  }

  .opening-index {
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
  }
</style>
