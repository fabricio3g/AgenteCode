<svelte:options runes={true} />

<!--
  The Code space surface.

  Radical calm: an almost empty canvas until there is work — one headline
  and one action per state. With a conversation open, the title bar's Code
  tools open the panes around it: Changes in the right dock (AppShell),
  terminals and processes below.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Bug, FlaskConical, Globe, Telescope } from 'lucide-svelte';
  import { ResizeHandle } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { codeStore } from './code.svelte';
  import { codeWorkspace } from './workspace.svelte';
  import CodeTranscript from './CodeTranscript.svelte';
  import CodeComposer from './CodeComposer.svelte';
  import BottomDock from './workspace/BottomDock.svelte';
  import { isCodeSession } from '$lib/features/shared/session-guards';

  onMount(() => {
    void codeStore.load();
    codeWorkspace.wire();
  });

  /**
   * The conversation to show: whatever code-space chat is current AND belongs
   * to a project. Keyed off the chat's own projectId — not the sidebar's
   * project selection — so a restored conversation (currentChatIdBySpace)
   * renders even if no folder row was ever clicked.
   */
  const chat = $derived.by(() => {
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

  // The right dock's Changes pane follows the open conversation.
  $effect(() => {
    codeWorkspace.changesTarget = chat && chatProject ? { chatId: chat.id, projectRoot: chatProject.rootPath, ...(sessionId ? { sessionId } : {}) } : null;
    return () => (codeWorkspace.changesTarget = null);
  });

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

  // ── Pane sizes ───────────────────────────────────────────────────────
  let mainColumn = $state<HTMLDivElement>();
  let startSize = 0;

  function resizeBottom(delta: number) {
    const max = Math.max(160, (mainColumn?.clientHeight ?? 800) - 180);
    codeWorkspace.setLayout({ bottomHeight: Math.round(Math.min(max, Math.max(120, startSize - delta))) });
  }

  const starters = $derived([
    { icon: Telescope, text: $t('code.starterExplain') },
    { icon: Bug, text: $t('code.starterBug') },
    { icon: FlaskConical, text: $t('code.starterTests') },
    { icon: Globe, text: $t('code.starterRun') }
  ]);

  function useStarter(text: string) {
    window.dispatchEvent(new CustomEvent('code-composer-draft', { detail: text }));
  }
</script>

<div class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
  {#if !codeStore.loaded && codeStore.loading}
    <div class="flex flex-1 items-center justify-center"></div>
  {:else if !codeStore.projects.length}
    <!-- Calm default: one headline, one action. -->
    <div class="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <div class="max-w-md space-y-2">
        <h1 class="text-2xl font-semibold tracking-tight text-foreground">{$t('code.surfaceTitle')}</h1>
        <p class="text-sm leading-relaxed text-muted-foreground">{$t('code.noProjectsHint')}</p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        onclick={() => void codeStore.addProject()}
      >
        {$t('code.addProject')}
      </button>
    </div>
  {:else if chat}
    <div class="flex min-h-0 flex-1">
      <!-- Conversation + bottom dock -->
      <div class="flex min-h-0 min-w-0 flex-1 flex-col" bind:this={mainColumn}>
        <div class="flex min-h-0 flex-1 flex-col">
          {#if !chat.messages.length && !unlinked}
            <div class="flex flex-1 flex-col items-center justify-center gap-4 px-6">
              <p class="text-sm text-muted-foreground">{$t('code.startersTitle')}</p>
              <div class="grid w-full max-w-xl gap-2 sm:grid-cols-2">
                {#each starters as starter (starter.text)}
                  {@const Icon = starter.icon}
                  <button type="button" class="starter flex items-center gap-2.5 rounded-xl border border-border px-3.5 py-3 text-left text-[13px] text-foreground transition" onclick={() => useStarter(starter.text)}>
                    <Icon class="size-4 shrink-0 text-muted-foreground" />
                    <span class="min-w-0 flex-1">{starter.text.trim()}{starter.text.endsWith(' ') ? '…' : ''}</span>
                  </button>
                {/each}
              </div>
            </div>
          {:else}
            {#key chat.id}<CodeTranscript messages={chat.messages} chatId={chat.id} />{/key}
          {/if}
          {#if unlinked}
            <p class="mx-auto mb-4 max-w-3xl rounded-lg border border-border bg-muted/50 px-4 py-2.5 text-center text-xs text-muted-foreground">
              {$t('code.unlinkedHint')}
            </p>
          {:else}
            {#key chat.id}<CodeComposer {chat} />{/key}
          {/if}
        </div>

        {#if codeWorkspace.layout.bottomOpen && chatProject}
          <ResizeHandle
            axis="y"
            label={$t('codeWs.resizeBottom')}
            onstart={() => (startSize = codeWorkspace.layout.bottomHeight)}
            onresize={resizeBottom}
          />
          <div class="shrink-0 px-2 pb-2" style="height: {codeWorkspace.layout.bottomHeight}px">
            <BottomDock chatId={chat.id} cwd={chatProject.rootPath} />
          </div>
        {/if}
      </div>

    </div>
  {:else}
    <div class="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      {#if activeProject}
        <p class="max-w-md text-sm leading-relaxed text-muted-foreground">
          {$t('code.startConversation')}
        </p>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          onclick={() => void codeStore.newConversation(activeProject)}
        >
          {$t('code.newConversation')}
        </button>
      {:else}
        <p class="max-w-md text-sm leading-relaxed text-muted-foreground">{$t('code.surfacePickProject')}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .starter {
    background: transparent;
  }

  .starter:hover {
    background: var(--muted);
    border-color: color-mix(in srgb, var(--foreground) 25%, transparent);
  }
</style>
