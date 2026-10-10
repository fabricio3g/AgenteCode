<svelte:options runes={true} />

<!--
  Scene header: everything that controls a roleplay scene, pinned above the
  conversation instead of crowding the composer.

  Cast avatars (click to speak now, hover to mute, "+" to edit the cast), auto
  mode with a live countdown, scene settings, and the user's persona. Identity
  itself stays on the messages — no name/tagline here.
-->

<script lang="ts">
  import { cn as uiClass } from '$lib/utils/cn';

  import Avatar from '$lib/components/ui/Avatar.svelte';
  import { Ban, BookOpen, Pause, Pencil, Play, Plus, Settings2 } from 'lucide-svelte';
  import { Button, IconButton, Select, Tooltip } from '$lib/components/ui';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
  import type { CharacterCard, UserPersona } from '$lib/types/chat';
  import { t } from 'svelte-i18n';

  interface Props {
    characters?: CharacterCard[];
    personas?: UserPersona[];
    activePersonaId?: string | null;
    mutedIds?: string[];
    nextSpeakerId?: string | null;
    autoMode?: boolean;
    /** Turns the scene controls off while a reply is generating. */
    disabled?: boolean;
    onpersona?: (personaId: string | null) => void;
    onpersonaedit?: (persona: UserPersona | null) => void;
    oncastedit?: () => void;
    onspeak?: (characterId: string) => void;
    onmute?: (characterId: string) => void;
    onauto?: (enabled: boolean) => void;
    onjournal?: () => void;
    mode?: 'chat' | 'narrative' | 'dynamic';
    onmode?: (mode: 'chat' | 'narrative' | 'dynamic') => void;
    onsettings?: () => void;
    presentIds?: string[];
  }

  let {
    characters = [],
    personas = [],
    activePersonaId = null,
    mutedIds = [],
    nextSpeakerId = null,
    autoMode = false,
    disabled = false,
    onpersona,
    onpersonaedit,
    oncastedit,
    onspeak,
    onmute,
    onauto,
    onjournal,
    mode = 'chat', onmode, onsettings, presentIds
  }: Props = $props();

  const group = $derived(characters.length > 1);
  const showBar = $derived(characters.length > 0 || (personas.length > 0 && !!onpersona) || !!onpersonaedit);

  const personaOptions = $derived([
    { value: '', label: $t('roleplay.header.noPersona') },
    ...personas.map((persona) => ({ value: persona.id, label: persona.name }))
  ]);

  /** Live countdown for the pending auto turn. */
  let now = $state(Date.now());
  const deadline = $derived(roleplayStore.autoDeadlines[appStore.currentChatId || ''] || 0);
  const remainingSeconds = $derived(deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0);

  $effect(() => {
    if (!deadline) return;
    const timer = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(timer);
  });

  // Typing pauses the chain instead of waiting for the fire-time check.
  $effect(() => {
    if (!appStore.composer.trim() || !deadline) return;
    roleplayStore.pauseAuto();
  });

  function isMuted(id: string): boolean {
    return mutedIds.includes(id);
  }

  function editActivePersona() {
    onpersonaedit?.(personas.find((persona) => persona.id === activePersonaId) || null);
  }

  function toggleAuto() {
    // While a continuation is pending the pill stops the chain; otherwise it
    // turns auto mode on or off.
    if (deadline) {
      roleplayStore.pauseAuto();
      return;
    }
    onauto?.(!autoMode);
  }
</script>

{#if showBar}
  <div class="scene-header">
    <div class="mode-group">
      <SegmentedControl value={mode} options={['chat', 'narrative', 'dynamic'].map((value) => ({ value, label: $t(`roleplay.settings.option.${value}`), disabled }))} label={$t('roleplay.settings.field.interactionMode')} variant="tabs" shape="rect" class="shrink-0" onchange={(value) => onmode?.(value as 'chat' | 'narrative' | 'dynamic')} />
      <span class="mode-hint" title={$t(`roleplay.modeHint.${mode}`)}>{$t(`roleplay.modeHint.${mode}`)}</span>
    </div>
    {#if characters.length}
      <div class="cast-strip" role="group" aria-label={$t('roleplay.header.cast')}>
        {#each characters as character (character.id)}
          <div class="cast-member {character.id === nextSpeakerId ? 'is-next' : ''} {isMuted(character.id) || (presentIds && !presentIds.includes(character.id)) ? 'is-muted' : ''}">
            <Button variant="plain"
              type="button"
              class={uiClass("cast-avatar", "ui-local-0298d9bd")}
              title={isMuted(character.id) ? $t('roleplay.header.muted', { values: { name: character.name } }) : $t('roleplay.header.speakNow', { values: { name: character.name } })}
              aria-label={isMuted(character.id) ? $t('roleplay.header.muted', { values: { name: character.name } }) : $t('roleplay.header.speakNow', { values: { name: character.name } })}
              onclick={() => onspeak?.(character.id)}
              disabled={disabled || (presentIds && !presentIds.includes(character.id))}
            >
              <Avatar size="fill" name={character.name ?? ''} image={character.avatar} />
            </Button>
            {#if isMuted(character.id)}
              <span class="muted-badge"><Ban class="size-2.5" /></span>
            {/if}
            <IconButton label={isMuted(character.id) ? $t('roleplay.header.unmute', { values: { name: character.name } }) : $t('roleplay.header.mute', { values: { name: character.name } })} size="xs" variant="ghost"
              type="button"
              class={uiClass("mute-btn", "ui-local-0298d9bd")}

              title={isMuted(character.id) ? $t('roleplay.header.unmute', { values: { name: character.name } }) : $t('roleplay.header.mute', { values: { name: character.name } })}
              onclick={() => onmute?.(character.id)}
            >
              <Ban class="size-2.5" />
            </IconButton>
          </div>
        {/each}
        {#if oncastedit}
          <IconButton
            variant="outline"
            label={$t('roleplay.header.editCast')}
            title={$t('roleplay.header.editCast')}
            onclick={oncastedit}
          >
            <Plus />
          </IconButton>
        {/if}
      </div>
    {/if}

    {#if group && (autoMode || deadline)}
      <Button
        variant="secondary"
        size="sm"
        aria-pressed={autoMode || !!deadline}
        title={deadline ? $t('roleplay.header.stopPending') : autoMode ? $t('roleplay.header.pauseAuto') : $t('roleplay.header.startAuto')}
        onclick={toggleAuto}
      >
        {#if autoMode && !deadline}
          <Pause class="size-3" />
        {:else if deadline}
          <span class="auto-count">{remainingSeconds}s</span>
        {:else}
          <Play class="size-3" />
        {/if}
        <span>{$t('roleplay.header.auto')}</span>
      </Button>
    {/if}

    {#if onjournal}
      <Tooltip label={$t('roleplay.memory.title')} position="bottom"><IconButton label={$t('roleplay.memory.title')} title="" onclick={onjournal}>
        <BookOpen />
      </IconButton></Tooltip>
    {/if}

    <Tooltip label={$t('roleplay.settings.title')} position="bottom"><IconButton label={$t('roleplay.settings.title')} title="" disabled={disabled} onclick={() => onsettings?.()}><Settings2 /></IconButton></Tooltip>

    <div class="persona-group">
      {#if personas.length && onpersona}
        <div class="bar-select">
          <Select
            value={activePersonaId || ''}
            options={personaOptions}
            aria-label={$t('roleplay.header.persona')}
            onchange={(value) => onpersona?.(value || null)}
          />
        </div>
        {#if onpersonaedit}
          <Tooltip label={activePersonaId ? $t('roleplay.header.editPersona') : $t('roleplay.header.newPersona')} position="bottom"><IconButton
            title=""
            label={activePersonaId ? $t('roleplay.header.editPersona') : $t('roleplay.header.newPersona')}

            onclick={editActivePersona}
          >
            <Pencil />
          </IconButton></Tooltip>
        {/if}
      {:else if onpersonaedit}
        <Button variant="outline" size="sm" onclick={() => onpersonaedit?.(null)}>
          <Plus class="size-3" />
          <span>{$t('roleplay.header.newPersona')}</span>
        </Button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scene-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    flex-shrink: 0;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--chat-bg);
  }

  .cast-strip {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    max-width: 100%;
    padding: 0.375rem;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .cast-member {
    position: relative;
    flex-shrink: 0;
  }

  :global(.cast-avatar.ui-local-0298d9bd) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--card);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      box-shadow var(--motion-fast) var(--motion-ease),
      opacity var(--motion-fast) var(--motion-ease);
  }


  :global(.cast-avatar:focus-visible.ui-local-0298d9bd) {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  :global(.cast-avatar:hover.ui-local-0298d9bd) {
    border-color: var(--border-hover);
  }

  .cast-member.is-next :global(.cast-avatar.ui-local-0298d9bd) {
    border-color: var(--primary);
    box-shadow: 0 0 0 1px var(--primary);
  }

  .cast-member.is-muted :global(.cast-avatar.ui-local-0298d9bd) {
    opacity: 0.45;
  }

  .muted-badge {
    position: absolute;
    right: -0.125rem;
    bottom: -0.125rem;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 0.875rem;
    height: 0.875rem;
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--text-muted);
    pointer-events: none;
  }

  /* Revealed on hover: quiet until you need it. */
  :global(.mute-btn.ui-local-0298d9bd) {
    position: absolute;
    right: -0.25rem;
    top: -0.25rem;
    display: none;
    align-items: center;
    justify-content: center;
    width: 0.875rem;
    height: 0.875rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--popover);
    color: var(--text-muted);
    cursor: pointer;
  }

  .cast-member:hover :global(.mute-btn.ui-local-0298d9bd),
  .cast-member:focus-within :global(.mute-btn.ui-local-0298d9bd) {
    display: flex;
  }

  :global(.mute-btn:hover.ui-local-0298d9bd) {
    color: var(--foreground);
  }

  .auto-count {
    font-variant-numeric: tabular-nums;
  }

  .mode-group {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-width: 0;
    flex-shrink: 0;
  }

  .mode-hint {
    min-width: 0;
    max-width: 13rem;
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .persona-group {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
    min-width: 0;
  }

  .bar-select {
    max-width: 11rem;
    min-width: 0;
  }

</style>
