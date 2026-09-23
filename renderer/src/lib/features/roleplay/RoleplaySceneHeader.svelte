<svelte:options runes={true} />

<!--
  Scene header: everything that controls a roleplay scene, pinned above the
  conversation instead of crowding the composer.

  Cast avatars (click to speak now, hover to mute, "+" to edit the cast), auto
  mode with a live countdown, scene settings, and the user's persona. Identity
  itself stays on the messages — no name/tagline here.
-->

<script lang="ts">
  import { Ban, BookOpen, Dices, ListOrdered, Pause, Pencil, Play, Plus, Settings2 } from 'lucide-svelte';
  import { Menu, MenuItem, Select } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import type { CharacterCard, RoleplayReplyOrder, UserPersona } from '$lib/types/chat';

  interface Props {
    characters?: CharacterCard[];
    personas?: UserPersona[];
    activePersonaId?: string | null;
    mutedIds?: string[];
    nextSpeakerId?: string | null;
    autoMode?: boolean;
    autoDelayMs?: number;
    adventureChoices?: boolean;
    choiceTimerSeconds?: number | null;
    propsEnabled?: boolean;
    showSpeakerLabels?: boolean;
    replyOrder?: RoleplayReplyOrder;
    /** Turns the scene controls off while a reply is generating. */
    disabled?: boolean;
    onpersona?: (personaId: string | null) => void;
    onpersonaedit?: (persona: UserPersona | null) => void;
    oncastedit?: () => void;
    onspeak?: (characterId: string) => void;
    onmute?: (characterId: string) => void;
    onauto?: (enabled: boolean) => void;
    onorder?: (order: RoleplayReplyOrder) => void;
    ondelay?: (delayMs: number) => void;
    onchoices?: (enabled: boolean) => void;
    ontimer?: (seconds: number | null) => void;
    onprops?: (enabled: boolean) => void;
    onlabels?: (enabled: boolean) => void;
    ontwist?: () => void;
    onjournal?: () => void;
  }

  let {
    characters = [],
    personas = [],
    activePersonaId = null,
    mutedIds = [],
    nextSpeakerId = null,
    autoMode = false,
    autoDelayMs = 8000,
    adventureChoices = false,
    choiceTimerSeconds = null,
    propsEnabled = false,
    showSpeakerLabels = false,
    replyOrder = 'list',
    disabled = false,
    onpersona,
    onpersonaedit,
    oncastedit,
    onspeak,
    onmute,
    onauto,
    onorder,
    ondelay,
    onchoices,
    ontimer,
    onprops,
    onlabels,
    ontwist,
    onjournal
  }: Props = $props();

  const group = $derived(characters.length > 1);
  const showBar = $derived(characters.length > 0 || (personas.length > 0 && !!onpersona) || !!onpersonaedit);

  const personaOptions = $derived([
    { value: '', label: 'No persona' },
    ...personas.map((persona) => ({ value: persona.id, label: persona.name }))
  ]);

  const orderOptions: Array<{ value: RoleplayReplyOrder; label: string }> = [
    { value: 'list', label: 'List order' },
    { value: 'natural', label: 'Natural order' },
    { value: 'mention', label: 'Mentions only' },
    { value: 'manual', label: 'Manual' }
  ];

  const delayOptions = [
    { value: 2000, label: '2s between turns' },
    { value: 4000, label: '4s between turns' },
    { value: 8000, label: '8s between turns' },
    { value: 12000, label: '12s between turns' }
  ];

  /** A clock on the moment. Off is stored as 0 so the menu round-trips. */
  const timerOptions = [
    { value: 0, label: 'Choice timer: off' },
    { value: 30, label: 'Choice timer: 30s' },
    { value: 60, label: 'Choice timer: 60s' }
  ];

  /** Live countdown for the pending auto turn. */
  let now = $state(Date.now());
  const deadline = $derived(appStore.roleplayAutoDeadlines[appStore.currentChatId || ''] || 0);
  const remainingSeconds = $derived(deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0);

  $effect(() => {
    if (!deadline) return;
    const timer = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(timer);
  });

  // Typing pauses the chain instead of waiting for the fire-time check.
  $effect(() => {
    if (!appStore.composer.trim() || !deadline) return;
    appStore.pauseRoleplayAuto();
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
      appStore.pauseRoleplayAuto();
      return;
    }
    onauto?.(!autoMode);
  }
</script>

{#if showBar}
  <div class="scene-header">
    {#if characters.length}
      <div class="cast-strip" role="group" aria-label="Cast">
        {#each characters as character (character.id)}
          <div class="cast-member {character.id === nextSpeakerId ? 'is-next' : ''} {isMuted(character.id) ? 'is-muted' : ''}">
            <button
              type="button"
              class="cast-avatar"
              title={isMuted(character.id) ? `${character.name} (muted)` : `${character.name} — speak now`}
              aria-label={isMuted(character.id) ? `${character.name} is muted` : `Have ${character.name} speak now`}
              onclick={() => onspeak?.(character.id)}
            >
              {#if character.avatar}
                <img src={character.avatar} alt={character.name} />
              {:else}
                <span>{character.name?.trim()?.[0]?.toUpperCase() || '?'}</span>
              {/if}
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

    {#if group}
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

    <button
      type="button"
      class="auto-pill {adventureChoices ? 'is-on' : ''}"
      aria-pressed={adventureChoices}
      title={adventureChoices ? 'Stop offering choices' : 'Offer choices after each reply'}
      onclick={() => onchoices?.(!adventureChoices)}
    >
      <ListOrdered class="size-3" />
      <span>Choices</span>
    </button>

    <button
      type="button"
      class="auto-pill"
      title="Throw a twist into the scene"
      disabled={disabled}
      onclick={() => ontwist?.()}
    >
      <Dices class="size-3" />
      <span>Twist</span>
    </button>

    {#if onjournal}
      <button type="button" class="aui-icon-button size-7" title="Scene journal" aria-label="Scene journal" onclick={onjournal}>
        <BookOpen class="size-3.5" />
      </button>
    {/if}

    <Menu placement="bottom-start" minWidth="13rem" label="Scene settings">
      {#snippet trigger(props)}
        <button type="button" class="aui-icon-button size-7" {...props} aria-label="Scene settings">
          <Settings2 class="size-3.5" />
        </button>
      {/snippet}
      {#if group}
        {#each orderOptions as option (option.value)}
          <MenuItem
            label={option.label}
            active={replyOrder === option.value}
            onselect={() => onorder?.(option.value)}
          />
        {/each}
        <div class="menu-separator"></div>
        {#each delayOptions as option (option.value)}
          <MenuItem
            label={option.label}
            active={autoDelayMs === option.value}
            onselect={() => ondelay?.(option.value)}
          />
        {/each}
        <div class="menu-separator"></div>
      {/if}
      {#each timerOptions as option (option.value)}
        <MenuItem
          label={option.label}
          active={(choiceTimerSeconds || 0) === option.value}
          onselect={() => ontimer?.(option.value || null)}
        />
      {/each}
      <div class="menu-separator"></div>
      <MenuItem label={adventureChoices ? 'Choices: on' : 'Choices: off'} active={adventureChoices} onselect={() => onchoices?.(!adventureChoices)} />
      <MenuItem label={propsEnabled ? 'Props: on' : 'Props: off'} active={propsEnabled} onselect={() => onprops?.(!propsEnabled)} />
      <MenuItem
        label={showSpeakerLabels ? 'Speaker labels: on' : 'Speaker labels: off'}
        active={showSpeakerLabels}
        onselect={() => onlabels?.(!showSpeakerLabels)}
      />
    </Menu>

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
            class="aui-icon-button size-7"
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

  .cast-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
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

  .cast-member:hover .mute-btn {
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

  .menu-separator {
    height: 1px;
    margin: 0.25rem 0.5rem;
    background: var(--border-subtle);
  }

  .persona-group {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
  }

  .bar-select {
    max-width: 11rem;
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
