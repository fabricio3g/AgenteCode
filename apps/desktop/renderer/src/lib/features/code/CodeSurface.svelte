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

  const starters = $derived([
    { icon: Telescope, text: $t('code.starterExplain') },
    { icon: Bug, text: $t('code.starterBug') },
    { icon: FlaskConical, text: $t('code.starterTests') },
    { icon: Globe, text: $t('code.starterRun') }
  ]);

  function useStarter(text: string) {
    window.dispatchEvent(new CustomEvent('code-composer-draft', { detail: { chatId: chat?.id, text } }));
  }
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
            <div class="starter-area">
              <div class="starter-content">
              <div class="starter-grid">
                {#each starters as starter (starter.text)}
                  {@const Icon = starter.icon}
                  <Button variant="plain" type="button" class={uiClass("starter flex items-center gap-2.5 rounded-xl border border-border px-3.5 py-3 text-left text-[13px] text-foreground transition", "ui-local-c4cff7cc")} onclick={() => useStarter(starter.text)}>
                    <Icon class="size-4 shrink-0 text-muted-foreground" />
                    <span class="min-w-0 flex-1">{starter.text.trim()}{starter.text.endsWith(' ') ? '…' : ''}</span>
                  </Button>
                {/each}
              </div></div>
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
  .starter-grid { display:grid; grid-template-columns:minmax(0,1fr);gap:0.5rem;width:100%;max-width:36rem; }
  @container (min-width: 38rem) { .starter-grid {grid-template-columns:repeat(2,minmax(0,1fr));} }
  :global(.starter.ui-local-c4cff7cc) { min-width:0; background:var(--control-bg);box-shadow:var(--control-inset); }
  .starter-area { min-height:0;flex:1;overflow-y:auto;display:flex;padding:1rem; }
  .starter-content { width:100%;max-width:36rem;margin:auto;display:flex;flex-direction:column;align-items:stretch;gap:1rem; }
  :global(.starter.ui-local-c4cff7cc) {
    background: var(--control-bg);
  }

  :global(.starter:hover.ui-local-c4cff7cc) {
    background: var(--muted);
    border-color: color-mix(in srgb, var(--foreground) 25%, transparent);
  }
</style>
