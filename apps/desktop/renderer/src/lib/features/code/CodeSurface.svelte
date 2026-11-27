<svelte:options runes={true} />

<!--
  The Code space surface.

  Radical calm: an almost empty canvas until there is work — one headline
  and one action per state. With a conversation open, the title bar's Code
  tools open the panes around it: Changes in the right dock (AppShell),
  terminals and processes below.
-->

<script lang="ts">
  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Bug, FlaskConical, FolderOpen, FolderPlus, GitBranch, Globe, Plus, Telescope } from '$lib/icons';
  import { Button } from '$lib/components/ui';
  import StarterList from '$lib/components/ui/StarterList.svelte';
  import ConversationProjectBox from './ConversationProjectBox.svelte';
  import type { Starter } from '$lib/components/ui/starter-list';
  import { formatShortcut } from '$lib/utils/shortcuts';
  import { appStore } from '$lib/stores/app.svelte';
  import { codeStore } from './code.svelte';
  import { codeWorkspace } from './workspace.svelte';
  import CodeTranscript from './CodeTranscript.svelte';
  import CodeComposer from './CodeComposer.svelte';
  import SubagentPill from './SubagentPill.svelte';
  import TasksPanel from './TasksPanel.svelte';
  import { isCodeSession } from '$lib/features/shared/session-guards';
  import type { ChatSession } from '$lib/types/chat';
  import { spaceVisible } from '$lib/components/layout/space-visibility';

  onMount(() => {
    void codeStore.load();
    codeWorkspace.wire();
  });

  /** The four starters, in key order; their copy lives in `code.starters.<id>`. */
  const STARTER_IDS = ['explain', 'bug', 'tests', 'run'] as const;
  const STARTER_ICONS = { explain: Telescope, bug: Bug, tests: FlaskConical, run: Globe };
  /** Hue identifies the kind — understand · fix · verify · see it — not emphasis.
   *  The four are 105–120° apart and stay four apart under protanopia and
   *  deuteranopia (min ΔEok 6.9 / 7.0, against 5.3 / 0.5 for the set this
   *  replaced: crimson and green used to collapse into one colour). */
  const STARTER_HUES = { explain: 325, bug: 8, tests: 130, run: 250 };
  /** Only the prompts that are the start of a sentence carry a slot. */
  const STARTER_SLOTS = new Set<string>(['bug', 'tests']);

  let {
    /**
     * The conversation this surface shows. A pane passes its own, so two panes
     * are two conversations; without one it falls back to the current chat,
     * which is what the single-pane window has always done.
     */
    chat: pinned = null
  }: { chat?: ChatSession | null } = $props();

  /**
   * The conversation to show: the one this surface was given, or whatever
   * code-space chat is current AND belongs to a project. Keyed off the chat's
   * own projectId — not the sidebar's project selection — so a restored
   * conversation (currentChatIdBySpace) renders even if no folder row was ever
   * clicked.
   */
  const chat = $derived.by(() => {
    if (pinned) return isCodeSession(pinned) ? pinned : null;
    const current = appStore.currentChat;
    // Until projects load, a chat without one cannot be judged yet.
    const judgeable = !!current?.projectId || codeStore.loaded;
    return current && judgeable && isCodeSession(current) ? current : null;
  });
  const chatProject = $derived(codeStore.projectById(chat?.projectId ?? null));
  /** Its project was deleted (older builds orphaned conversations): read-only.
      A new conversation with no folder yet is not that: its chip picks one. */
  const unlinked = $derived(!!chat?.projectId && codeStore.loaded && !chatProject);
  const activeProject = $derived(chatProject ?? codeStore.projectById(codeStore.activeProjectId));
  const run = $derived(codeStore.runFor(chat?.id));
  const sessionId = $derived(chat?.codeAgent?.sessionId || undefined);

  // The right dock's Changes pane follows the conversation the window is
  // focused on, and a pane and its dock move to another conversation in the
  // same breath. The pane that owns the keyboard writes this; a background
  // surface stays quiet, or two mounted conversations would take turns
  // overwriting it. See `ConversationPanes` for the writer.

  // History survives a restart: load it when a conversation opens, not only
  // when a run ends.
  $effect(() => {
    const id = chat?.id;
    if (id && chat?.codeAgent?.sessionId) void codeStore.refreshCheckpoints(id);
  });

  // The toolbar's change count stays current: reload on another conversation,
  // when a run settles or writes files, and when the window regains focus.
  $effect(() => {
    const id = chat?.id;
    const root = chatProject?.rootPath;
    void run?.running;
    void run?.fileChanges?.length;
    if (id && root) void codeWorkspace.refreshChanges({ chatId: id, projectRoot: root, ...(sessionId ? { sessionId } : {}) });
  });
  $effect(() => {
    const onFocus = () => {
      if (chat && chatProject) void codeWorkspace.refreshChanges({ chatId: chat.id, projectRoot: chatProject.rootPath, ...(sessionId ? { sessionId } : {}) });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });

  const starters = $derived<Starter[]>(STARTER_IDS.map((id, index) => ({
    id,
    icon: STARTER_ICONS[id],
    hue: STARTER_HUES[id],
    label: $t(`code.starters.${id}.label`),
    hint: $t(`code.starters.${id}.hint`),
    preview: $t(`code.starters.${id}.prompt`),
    slot: STARTER_SLOTS.has(id) ? $t(`code.starters.${id}.slot`) : undefined,
    key: formatShortcut(`mod+alt+${index + 1}`)
  })));

  /**
   * Hovering a link writes its prompt into the composer as a preview; leaving
   * clears it. The same event the draft uses keeps it scoped to this chat, so
   * a pane's own composer is the only one that changes.
   */
  function previewStarter(starter: Starter | null) {
    window.dispatchEvent(new CustomEvent('code-composer-preview', {
      detail: { chatId: chat?.id, text: starter?.preview ?? '' }
    }));
  }

  /**
   * Picking a starter fills the composer and focuses it; it never sends. The
   * prompt is a fragment the user may finish (that is what `slot` names), and
   * it is never rendered as a label — see the `code.starters` locale block.
   */
  function useStarter(id: string) {
    const index = STARTER_IDS.indexOf(id as (typeof STARTER_IDS)[number]);
    if (index < 0) return;
    window.dispatchEvent(new CustomEvent('code-composer-draft', {
      detail: {
        chatId: chat?.id,
        text: $t(`code.starters.${id}.prompt`),
        slot: STARTER_SLOTS.has(id) ? $t(`code.starters.${id}.slot`) : undefined
      }
    }));
  }

  /** Starting from a folder: the Add project dialog's three ways in, each opening its own tab. */
  const WAYS_IN = [
    { mode: 'open', icon: FolderOpen },
    { mode: 'new', icon: FolderPlus },
    { mode: 'clone', icon: GitBranch }
  ] as const;

  const shown = spaceVisible();
  /** The starters are on screen, so their keys are live. */
  /**
   * A new conversation, not one whose transcript is still loading (Code chats
   * load on open): only a new one gets the centred composer and the starters.
   */
  const empty = $derived(!!chat && chat.messagesLoaded !== false && !chat.messages.length);
  const startersShowing = $derived(empty && !unlinked);

  $effect(() => {
    if (!startersShowing) return;
    const onKey = (event: KeyboardEvent) => {
      // Code stays mounted behind other spaces; its keys are only its own while shown.
      if (!shown()) return;
      if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey) return;
      const index = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(event.code);
      if (index < 0 || index >= starters.length) return;
      event.preventDefault();
      useStarter(starters[index].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<div class="code-surface relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
  {#if !codeStore.loaded && codeStore.loading}
    <div class="flex flex-1 items-center justify-center"></div>
  {:else if chat}
    <div class="flex min-h-0 flex-1">
      <!-- Conversation + bottom dock. Before the first message the column is
           centred and the starters sit under the composer as one line of text;
           the composer itself keeps its slot in both states, so sending the
           first message never remounts it and never drops the keyboard. -->
      <div class="flex min-h-0 min-w-0 flex-1 flex-col" class:is-empty={!unlinked && empty}>
        {#if unlinked}
          <div class="ui-top-fade ui-bottom-fade flex min-h-0 min-w-0 flex-1 flex-col">
            {#key chat.id}<CodeTranscript messages={chat.messages} chatId={chat.id} />{/key}
          </div>
        {:else if empty}
          <!-- Where it will work, asked before the first message. -->
          {#if codeStore.canChangeProject(chat)}
            <div class="composer-column px-3 md:px-6"><ConversationProjectBox {chat} /></div>
          {/if}
        {:else}
          <div class="ui-top-fade ui-bottom-fade flex min-h-0 min-w-0 flex-1 flex-col">
            {#key chat.id}<CodeTranscript messages={chat.messages} chatId={chat.id} liveSubagentDock />{/key}
          </div>
        {/if}

        {#if unlinked}
          <p class="mx-auto mb-4 max-w-3xl rounded-lg border border-border bg-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
            {$t('code.unlinkedHint')}
          </p>
        {:else}
          {#key chat.id}<SubagentPill {chat} /><div class="chat-todos-wrap composer-column px-3 md:px-6"><TasksPanel {chat} /></div><CodeComposer {chat} />{/key}
          {#if empty}
            <div class="empty-links composer-column px-3 md:px-6">
              <StarterList {starters} label={$t('code.starters.title')} onpick={useStarter} onpreview={previewStarter} variant="links" />
            </div>
          {/if}
        {/if}
      </div>
    </div>
  {:else if !codeStore.projects.length}
    <!-- First run: what the space is for and one way in — a new conversation,
         whose composer picks the folder as you write. Starting from a folder
         (open, create, clone) stays one quiet line under it. -->
    <div class="no-projects">
      <div class="no-projects-head">
        <h1 class="no-projects-title">{$t('code.surfaceTitle')}</h1>
        <p class="no-projects-lead">{$t('code.noProjectsHint')}</p>
      </div>
      <button type="button" class="way-in" onclick={() => void codeStore.startConversation()}>
        <span class="way-in-icon" aria-hidden="true"><Plus /></span>
        <span class="way-in-text">
          <span class="way-in-title">{$t('code.empty.start')}</span>
          <span class="way-in-hint">{$t('code.empty.startHint')}</span>
        </span>
        <kbd class="way-in-key">{formatShortcut('mod+k')}</kbd>
      </button>
      <p class="from-folder">
        <span>{$t('code.empty.fromFolder')}</span>
        {#each WAYS_IN as way (way.mode)}
          {@const Icon = way.icon}
          <button type="button" class="from-folder-link" title={$t(`code.empty.${way.mode}Hint`)} onclick={() => void codeStore.addProject(undefined, way.mode)}>
            <Icon aria-hidden="true" />{$t(`code.empty.${way.mode}`)}
          </button>
        {/each}
      </p>
    </div>
  {:else}
    <div class="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      {#if activeProject}
        <p class="max-w-md text-sm leading-relaxed text-muted-foreground">
          {$t('code.startConversation')}
        </p>
        <Button variant="plain"
          type="button"
          class={uiClass("inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90", "ui-local-c4cff7cc")}
          onclick={() => void codeStore.newConversation(activeProject)}
        >
          {$t('code.newConversation')}
        </Button>
      {:else}
        <p class="max-w-md text-sm leading-relaxed text-muted-foreground">{$t('code.surfacePickProject')}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .code-surface { container-type: inline-size; }

  /* ── First run ───────────────────────────────────────────────────────── */
  .no-projects {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.75rem;
    padding: 2rem 1.5rem;
  }
  .no-projects-head {
    display: flex;
    max-width: 30rem;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    text-align: center;
  }
  .no-projects-title {
    margin: 0;
    color: var(--foreground);
    font-size: calc(26px * var(--reading-scale, 1));
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
  .no-projects-lead {
    margin: 0;
    max-width: 52ch;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
    line-height: 1.6;
  }
  /* The one action: a wide row — mark hard left, its key hard right. */
  .way-in {
    display: flex;
    width: 100%;
    max-width: 24rem;
    align-items: center;
    gap: 0.875rem;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--border);
    border-radius: var(--float-radius);
    background: var(--card);
    color: var(--foreground);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--motion-instant) var(--motion-ease), border-color var(--motion-instant) var(--motion-ease);
  }
  .way-in:hover {
    border-color: var(--border-hover);
    background: color-mix(in srgb, var(--foreground) 4%, var(--card));
  }
  .way-in:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--brand-accent);
  }
  .way-in-icon {
    display: inline-flex;
    width: 2.25rem;
    height: 2.25rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: calc(var(--float-row-radius) + 0.125rem);
    background: var(--foreground);
    color: var(--background);
  }
  .way-in-icon :global(svg) { width: 1.125rem; height: 1.125rem; }
  .way-in-text {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 0.125rem;
  }
  .way-in-title { font-size: var(--text-sm); font-weight: 500; }
  .way-in-hint { color: var(--muted-foreground); font-size: var(--text-xs); }
  .way-in-key {
    flex-shrink: 0;
    padding: 0.125rem 0.375rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    color: var(--muted-foreground);
    font-family: inherit;
    font-size: var(--text-xs);
  }
  /* Starting from a folder: one quiet line of links under the action. */
  .from-folder {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.25rem 0.75rem;
    margin: 0;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .from-folder-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem;
    border: 0;
    border-radius: var(--float-row-radius);
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    cursor: pointer;
    transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease);
  }
  .from-folder-link:hover,
  .from-folder-link:focus-visible {
    outline: none;
    background: var(--float-row-hover);
    color: var(--foreground);
  }
  .from-folder-link :global(svg) { width: 0.875rem; height: 0.875rem; }

  /* Before the first message the column centres instead of docking to the
     bottom: the composer is the only control on the screen, so it sits where
     the eye already is, with the folder above it and the four ways in below.
     The children are the same nodes either way — centring is the only change,
     so the composer keeps its focus across the first send. */
  .is-empty { justify-content:center;padding-block:1.5rem; }


  .empty-links { margin-top:0.75rem; }
  .chat-todos-wrap { flex-shrink: 0; margin-top: 0.375rem; margin-bottom: 0.25rem; }
  .chat-todos-wrap:empty { display: none; }
</style>
