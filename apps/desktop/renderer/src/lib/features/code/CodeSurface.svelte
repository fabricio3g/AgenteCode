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
  import { Bug, FlaskConical, FolderOpen, Globe, Telescope } from 'lucide-svelte';
  import { Button } from '$lib/components/ui';
  import StarterList from '$lib/components/ui/StarterList.svelte';
  import type { Starter } from '$lib/components/ui/starter-list';
  import { formatShortcut } from '$lib/utils/shortcuts';
  import { appStore } from '$lib/stores/app.svelte';
  import { codeStore } from './code.svelte';
  import { codeWorkspace } from './workspace.svelte';
  import CodeTranscript from './CodeTranscript.svelte';
  import CodeComposer from './CodeComposer.svelte';
  import { isCodeSession } from '$lib/features/shared/session-guards';
  import type { ChatSession } from '$lib/types/chat';

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
  /** Its project was deleted (older builds orphaned conversations): read-only. */
  const unlinked = $derived(!!chat && codeStore.loaded && !chatProject);
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
    slot: STARTER_SLOTS.has(id) ? $t(`code.starters.${id}.slot`) : undefined,
    key: formatShortcut(`mod+alt+${index + 1}`)
  })));

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

  /** The starters are on screen, so their keys are live. */
  const startersShowing = $derived(!!chat && !chat.messages.length && !unlinked);

  $effect(() => {
    if (!startersShowing) return;
    const onKey = (event: KeyboardEvent) => {
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
  {:else if !codeStore.projects.length}
    <!-- Calm default: one headline, one action (it opens the folder browser). -->
    <div class="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <div class="max-w-md space-y-2">
        <h1 class="text-2xl font-semibold tracking-tight text-foreground">{$t('code.surfaceTitle')}</h1>
        <p class="text-sm leading-relaxed text-muted-foreground">{$t('code.noProjectsHint')}</p>
      </div>
      <Button onclick={() => void codeStore.addProject()}><FolderOpen />{$t('code.addProject')}</Button>
    </div>
  {:else if chat}
    <div class="flex min-h-0 flex-1">
      <!-- Conversation + bottom dock -->
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <div class="flex min-h-0 flex-1 flex-col">
          {#if !chat.messages.length && !unlinked}
            <!-- Before the first message: the four things this agent is for,
                 anchored to the composer's edge rather than floating in the
                 middle of the canvas. Picking one fills the composer. -->
            <div class="starters-zone">
              <div class="starters-col">
                <div class="starters-head">
                  <span class="starters-title">{$t('code.starters.title')}</span>
                </div>
                <StarterList {starters} label={$t('code.starters.title')} onpick={useStarter} />
              </div>
            </div>
          {:else}
            <div class="ui-top-fade flex min-h-0 min-w-0 flex-1 flex-col">
              {#key chat.id}<CodeTranscript messages={chat.messages} chatId={chat.id} />{/key}
            </div>
          {/if}
          {#if unlinked}
            <p class="mx-auto mb-4 max-w-3xl rounded-lg border border-border bg-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
              {$t('code.unlinkedHint')}
            </p>
          {:else}
            {#key chat.id}<CodeComposer {chat} />{/key}
          {/if}
        </div>


      </div>

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

  /* The block hangs off the composer: the composer is what the eye should land
     on, and the starters explain it. It scrolls rather than clipping when the
     window is short. */
  .starters-zone { display:flex;min-height:0;flex:1;overflow-y:auto;flex-direction:column;justify-content:flex-end;padding:1.5rem 1.5rem 0.5rem; }
  .starters-col { width:100%;max-width:var(--thread-width);margin:0 auto; }

  /* One label, hard left. The keys each row answers to are on the rows
     themselves — a range in the header said the same thing four times. */
  .starters-head { display:flex;align-items:baseline;gap:0.5rem;padding:0 0.5rem 0.5rem; }
  .starters-title { color:var(--muted-foreground);font-size:var(--text-xs);font-weight:500;letter-spacing:0.02em;text-transform:uppercase; }
</style>
