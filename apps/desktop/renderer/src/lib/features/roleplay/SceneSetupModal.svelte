<svelte:options runes={true} />

<!--
  Scene setup.

  Turns a world (or a bare character) into a concrete scene: choose the cast,
  the persona, and the opening line. The first cast member is the primary
  speaker; two or more make it a group scene.
-->

<script lang="ts">
  import DialogActions from '$lib/components/ui/DialogActions.svelte';

  import DialogFooter from '$lib/components/ui/DialogFooter.svelte';

  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { untrack } from 'svelte';
  import { Globe2, Info, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { Button, Select, Tooltip } from '$lib/components/ui';
  import type { CharacterCard, RoleplaySettings, RoleplayWorld } from '$lib/types/chat';
  import RoleplaySettingsEditor from './RoleplaySettingsEditor.svelte';
  import { roleplayPreferences } from './roleplay-presets.svelte';
  import { resolveRoleplaySettings } from './roleplay-settings';
  import { charactersStore, greetingsFor } from './characters.svelte';
  import { roleplayStore } from './roleplay.svelte';
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
  // The persona is the last one a scene used (or the world's own); none otherwise.
  let personaId = $state<string>(
    untrack(() => world?.defaultPersonaId || roleplayPreferences.lastPersonaId(charactersStore.personas) || '')
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

  /** An opening as the scene will read it: {{char}} the primary, {{user}} the persona picked here. */
  function previewOf(text: string): string {
    // A one-line preview: the markdown marks are dropped, the names resolved.
    return roleplayStore.previewText(text, {
      char: primary?.name,
      personaId: personaId || null,
      group: cast.map((card) => card.name),
      seed: primary?.id
    }).replace(/[*_~`#]+/g, '').replace(/\s+/g, ' ').trim();
  }

  const personaOptions = $derived([
    { value: '', label: $t('roleplay.header.noPersona') },
    ...charactersStore.personas.map((persona) => ({ value: persona.id, label: persona.name }))
  ]);

  /** Why Start is off, in words: the one thing missing. */
  const blocker = $derived(!cast.length ? $t('roleplay.setup.needCast') : !selectedOpening ? $t('roleplay.setup.needOpening') : '');
  const modeName = $derived($t(`roleplay.settings.option.${sceneSettings.interactionMode ?? inherited.interactionMode ?? 'chat'}`));

  function start() {
    if (blocker || !primary || !selectedOpening) return;
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
        <div class="ui-modal-title">{world ? world.name : $t('roleplay.setup.newScene')}</div>
        <div class="text-xs text-muted-foreground">
          {group ? $t('roleplay.setup.groupScene', { values: { n: cast.length } }) : $t('roleplay.setup.oneOnOne')}
          {world ? ` · ${$t('roleplay.setup.worldCanon')}` : ''}
        </div>
      </div>
      <Tooltip label={copy.actions.close} position="bottom"><UiIconButton label={copy.actions.close} size="sm" type="button" class={uiClass("", "ui-local-fd4911dc")} onclick={onclose} >
        <X class="size-4" />
      </UiIconButton></Tooltip>
    </div>

    <div class="ui-modal-body max-h-[64vh] space-y-5 overflow-y-auto">
      <details class="more-options">
        <summary>
          <span>{$t('roleplay.setup.moreOptions')}</span>
          <span class="more-mode">{modeName}</span>
        </summary>
        <div class="pt-4"><RoleplaySettingsEditor value={sceneSettings} {inherited} onchange={(next) => (sceneSettings = next)} /></div>
      </details>
      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-medium text-muted-foreground">{$t('roleplay.setup.cast')}</span>
          {#if cast.length}
            <span class="text-[12px] text-muted-foreground">{$t('roleplay.setup.castOrderHint')}</span>
          {/if}
        </div>
        <CastPicker value={castIds} onchange={(ids) => (castIds = ids)} />
      </div>

      <div class="space-y-1.5">
        <span class="text-sm font-medium text-muted-foreground">{$t('roleplay.setup.persona')}</span>
        <Select
          variant="surface"
          value={personaId}
          options={personaOptions}
          aria-label={$t('roleplay.setup.persona')}
          onchange={(value) => (personaId = value)}
        />
      </div>

      <div class="space-y-3">
        <span class="text-sm font-medium text-muted-foreground">{$t('roleplay.setup.opening')}</span>
        {#if worldOpenings.length}
          <div class="space-y-1.5">
            <span class="text-[12px] text-muted-foreground">{$t('roleplay.setup.worldOpenings')}</span>
            {#each worldOpenings as opening (opening.key)}
              <Button variant="plain"
                type="button"
                class={uiClass(`opening-option ${selectedOpening?.key === opening.key ? 'is-on' : ''}`, "ui-local-fd4911dc")}
                onclick={() => (openingKey = opening.key)}
                aria-pressed={selectedOpening?.key === opening.key}
              >
                <span class="opening-source"><Globe2 class="size-3" /></span>
                <span class="line-clamp-3 text-left text-[12px] text-foreground">{previewOf(opening.text)}</span>
              </Button>
            {/each}
          </div>
        {/if}
        {#if greetingOpenings.length}
          <div class="space-y-1.5">
            <span class="text-[12px] text-muted-foreground">{$t('roleplay.setup.greetingsOf', { values: { name: primary?.name || $t('roleplay.setup.character') } })}</span>
            {#each greetingOpenings as opening (opening.key)}
              <Button variant="plain"
                type="button"
                class={uiClass(`opening-option ${selectedOpening?.key === opening.key ? 'is-on' : ''}`, "ui-local-fd4911dc")}
                onclick={() => (openingKey = opening.key)}
                aria-pressed={selectedOpening?.key === opening.key}
              >
                <span class="opening-source"><span class="opening-index">{opening.index + 1}</span></span>
                <span class="line-clamp-3 text-left text-[12px] text-foreground">{previewOf(opening.text)}</span>
              </Button>
            {/each}
          </div>
        {/if}
        <Button variant="plain"
          type="button"
          class={uiClass(`opening-option ${selectedOpening?.source === 'none' ? 'is-on' : ''}`, "ui-local-fd4911dc")}
          onclick={() => (openingKey = noOpening.key)}
          aria-pressed={selectedOpening?.source === 'none'}
        >
          <span class="opening-source"><X class="size-3" /></span>
          <span class="text-left text-[12px] text-muted-foreground">{$t('roleplay.setup.noOpening')}</span>
        </Button>
      </div>
    </div>

    <DialogFooter >
      {#if blocker}
        <span class="blocker" role="status"><Info class="size-3.5 shrink-0" /><span>{blocker}</span></span>
      {/if}
      <DialogActions cancelLabel={copy.actions.cancel} confirmLabel={group ? $t('roleplay.setup.startGroup') : $t('roleplay.setup.start')} oncancel={onclose} onconfirm={start} disabled={!!blocker} confirmTitle={blocker || undefined} />
    </DialogFooter>
  </div>
</div>

<style>
  :global(.opening-option.ui-local-fd4911dc) {
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

  :global(.opening-option:hover.ui-local-fd4911dc) {
    background: var(--surface-hover);
  }

  :global(.opening-option.is-on.ui-local-fd4911dc) {
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

  .more-options summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }

  .more-mode {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .blocker {
    display: inline-flex;
    flex: 1;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    margin-right: auto;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .opening-index {
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
</style>
