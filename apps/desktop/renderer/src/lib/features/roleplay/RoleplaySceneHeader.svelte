<svelte:options runes={true} />

<!--
  Scene header: everything that controls a roleplay scene, pinned above the
  conversation instead of crowding the composer.

  Cast avatars (click to speak now, hover to mute, "+" to edit the cast), auto
  mode with a live countdown, scene settings, and the user's persona. Identity
  itself stays on the messages — no name/tagline here.
-->

<script lang="ts">
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import { Ban, BookOpen, Pause, Pencil, Play, Plus, Settings2 } from 'lucide-svelte';
  import { Select } from '$lib/components/ui';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
  import type { CharacterCard, UserPersona } from '$lib/types/chat';

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
    { value: '', label: 'No persona' },
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
    <SegmentedControl value={mode} options={['chat', 'narrative', 'dynamic'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1), disabled }))} label="Roleplay mode" variant="tabs" class="shrink-0" onchange={(value) => onmode?.(value as 'chat' | 'narrative' | 'dynamic')} />
    {#if characters.length}
      <div class="cast-strip" role="group" aria-label="Cast">
        {#each characters as character (character.id)}
          <div class="cast-member {character.id === nextSpeakerId ? 'is-next' : ''} {isMuted(character.id) || (presentIds && !presentIds.includes(character.id)) ? 'is-muted' : ''}">
            <button
              type="button"
              class="cast-avatar"
              title={isMuted(character.id) ? `${character.name} (muted)` : `${character.name} — speak now`}
              aria-label={isMuted(character.id) ? `${character.name} is muted` : `Have ${character.name} speak now`}
              onclick={() => onspeak?.(character.id)}
              disabled={disabled || (presentIds && !presentIds.includes(character.id))}
            >
              <Avatar size="fill" name={character.name ?? ''} image={character.avatar} />
            </button>
            {#if isMuted(character.id)}
              <span class="muted-badge"><Ban class="size-2.5" /></span>
            {/if}
            <button
              type="button"
              class="mute-btn"
              aria-label={isMuted(character.id) ? `Unmute ${character.name}` : `Mute ${character.name}`}
              onclick={() => onmute?.(character.id)}
            >
              <Ban class="size-2.5" />
            </button>
          </div>
        {/each}
        {#if oncastedit}
          <button
            type="button"
            class="cast-add"
            aria-label="Edit the scene cast"
            title="Add or remove characters"
            onclick={oncastedit}
          >
            <Plus class="size-3.5" />
          </button>
        {/if}
      </div>
    {/if}

    {#if group && (autoMode || deadline)}
      <button
        type="button"
        class="auto-pill {autoMode || deadline ? 'is-on' : ''}"
        aria-pressed={autoMode || !!deadline}
        title={deadline ? 'Stop the pending turn' : autoMode ? 'Pause auto mode' : 'Let characters keep talking'}
        onclick={toggleAuto}
      >
        {#if autoMode && !deadline}
          <Pause class="size-3" />
        {:else if deadline}
          <span class="auto-count">{remainingSeconds}s</span>
        {:else}
          <Play class="size-3" />
        {/if}
        <span>Auto</span>
      </button>
    {/if}

    {#if onjournal}
      <button type="button" class="aui-icon-button is-sm" title="Scene journal" aria-label="Scene journal" onclick={onjournal}>
        <BookOpen class="size-3.5" />
      </button>
    {/if}

    <button type="button" class="aui-icon-button is-sm" aria-label="Roleplay settings" title="Customize this conversation" disabled={disabled} onclick={() => onsettings?.()}><Settings2 class="size-3.5" /></button>

    <div class="persona-group">
      {#if personas.length && onpersona}
        <div class="bar-select">
          <Select
            variant="surface"
            value={activePersonaId || ''}
            options={personaOptions}
            aria-label="User persona"
            onchange={(value) => onpersona?.(value || null)}
          />
        </div>
        {#if onpersonaedit}
          <button
            type="button"
            class="aui-icon-button is-sm"
            aria-label="Edit persona"
            title={activePersonaId ? 'Edit persona' : 'New persona'}
            onclick={editActivePersona}
          >
            <Pencil class="size-3.5" />
          </button>
        {/if}
      {:else if onpersonaedit}
        <button type="button" class="persona-add" onclick={() => onpersonaedit?.(null)}>
          <Plus class="size-3" />
          <span>New persona</span>
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scene-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.375rem;
    flex-shrink: 0;
    padding: 0.375rem 0.75rem;
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

  .cast-avatar {
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
    font-size: 0.6875rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      box-shadow var(--motion-fast) var(--motion-ease),
      opacity var(--motion-fast) var(--motion-ease);
  }


  .cast-avatar:hover {
    border-color: var(--border-hover);
  }

  .cast-member.is-next .cast-avatar {
    border-color: var(--primary);
    box-shadow: 0 0 0 1px var(--primary);
  }

  .cast-member.is-muted .cast-avatar {
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
  .mute-btn {
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

  .cast-member:hover .mute-btn,
  .cast-member:focus-within .mute-btn {
    display: flex;
  }

  .mute-btn:hover {
    color: var(--foreground);
  }

  .cast-add {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
    border: 1px dashed var(--border);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .cast-add:hover {
    border-color: var(--border-hover);
    color: var(--foreground);
  }

  .auto-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
    padding: 0.1875rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--card);
    color: var(--text-muted);
    font-size: 0.6875rem;
    font-weight: 500;
    cursor: pointer;
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease),
      background-color var(--motion-fast) var(--motion-ease);
  }

  .auto-pill:hover {
    color: var(--foreground);
  }

  .auto-pill.is-on {
    border-color: var(--primary);
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .auto-count {
    font-variant-numeric: tabular-nums;
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

  .persona-add {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1875rem 0.5rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    font-size: 0.6875rem;
    cursor: pointer;
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .persona-add:hover {
    border-color: var(--border-hover);
    color: var(--foreground);
  }
</style>
