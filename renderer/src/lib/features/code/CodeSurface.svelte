<svelte:options runes={true} />

<!--
  The Code space surface.

  Radical calm: an almost empty canvas until there is work —
  one headline and one action per state. The conversation header carries
  only the project name; checkpoint history folds into a single popover so
  the resting bar stays quiet.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Archive, Bug, FlaskConical, Globe, History, MoreHorizontal, Telescope } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { say } from '$lib/copy';
  import { codeStore } from './code.svelte';
  import CodeTranscript from './CodeTranscript.svelte';
  import CodeComposer from './CodeComposer.svelte';
  import CodeExtensionsPanel from './CodeExtensionsPanel.svelte';
  import { isCodeSession } from '$lib/features/shared/session-guards';
  import { displayChatTitle } from '$lib/features/shared/session-title';

  onMount(() => {
    void codeStore.load();
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

  let historyOpen = $state(false);
  let moreOpen = $state(false);

  // History survives a restart: load it when a conversation opens, not only
  // when a run ends.
  $effect(() => {
    const id = chat?.id;
    if (id && chat?.codeAgent?.sessionId) void codeStore.refreshCheckpoints(id);
  });

  /** Checkpoints newest first, each with every file a restore would touch. */
  const checkpoints = $derived([...(run?.checkpoints ?? [])].reverse());

  function confirmRestore(turnIndex: number) {
    if (!chat) return;
    const chatId = chat.id;
    // Restoring to a turn also undoes every later one: list all their files.
    const files = [...new Set((run?.checkpoints ?? []).filter((c) => c.turnIndex >= turnIndex).flatMap((c) => c.files ?? []))];
    confirmStore.show({
      title: $t('code.restoreTitle'),
      message: $t('code.restoreMessage'),
      details: files.length ? files : undefined,
      confirmLabel: $t('code.restore'),
      danger: true,
      onConfirm: async () => {
        const result = await codeStore.restoreCheckpoint(chatId, turnIndex);
        if (result.ok) toastStore.success($t('code.restoreDone', { values: { files: say.files(result.files.length) } }));
        else toastStore.error($t('code.restoreFailed', { values: { error: result.error ?? '' } }));
      }
    });
  }

  async function compact() {
    if (!chat) return;
    const result = await codeStore.compact(chat.id);
    if (!result.ok) toastStore.error($t('code.compactFailed', { values: { error: result.error ?? '' } }));
  }

  function timeLabel(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    <!-- Conversation header: project identity left, run history right. -->
    <div class="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/80 px-4 backdrop-blur">
      <div
        class="min-w-0 truncate text-xs font-medium text-foreground"
        title={activeProject?.rootPath || chat.title}
      >
        {activeProject?.rootName ?? displayChatTitle(chat)}
      </div>

      <div class="flex shrink-0 items-center gap-1">
        {#if checkpoints.length}
          <Menu bind:open={historyOpen} placement="bottom-end" minWidth="16rem" label={$t('code.history')}>
            {#snippet trigger(props)}
              <button
                type="button"
                class="history-trigger inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
                {...props}
              >
                <History class="size-3" />
                {$t('code.history')}
                <span class="tabular-nums opacity-70">{checkpoints.length}</span>
              </button>
            {/snippet}
            <p class="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold text-muted-foreground">{$t('code.historyTitle')}</p>
            {#each checkpoints as checkpoint (checkpoint.turnIndex)}
              <MenuItem onselect={() => confirmRestore(checkpoint.turnIndex)}>
                <span class="min-w-0 flex-1 truncate">
                  <span class="font-medium text-foreground">{timeLabel(checkpoint.createdAt)}</span>
                  <span class="text-muted-foreground"> · {say.files(checkpoint.fileCount)}</span>
                </span>
                <span class="font-mono tabular-nums">
                  <span class="text-success">+{checkpoint.additions}</span>
                  <span class="text-error">−{checkpoint.deletions}</span>
                </span>
              </MenuItem>
            {/each}
          </Menu>
        {/if}
        <Menu bind:open={moreOpen} placement="bottom-end" minWidth="14rem" label={$t('code.moreActions')}>
          {#snippet trigger(props)}
            <button type="button" class="aui-icon-button size-7" aria-label={$t('code.moreActions')} title={$t('code.moreActions')} {...props}>
              <MoreHorizontal class="size-4" />
            </button>
          {/snippet}
          <MenuItem icon={Archive} disabled={!codeStore.hasSession(chat.id) || !!run?.running} onselect={() => void compact()}>
            <span class="flex min-w-0 flex-col">
              <span>{$t('code.compact')}</span>
              <span class="text-[10px] text-muted-foreground">{$t('code.compactHint')}</span>
            </span>
          </MenuItem>
        </Menu>
        <CodeExtensionsPanel />
      </div>
    </div>

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
      <CodeTranscript messages={chat.messages} chatId={chat.id} />
    {/if}
    {#if unlinked}
      <p class="mx-auto mb-4 max-w-3xl rounded-lg border border-border bg-muted/50 px-4 py-2.5 text-center text-xs text-muted-foreground">
        {$t('code.unlinkedHint')}
      </p>
    {:else}
      <CodeComposer {chat} />
    {/if}
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
  .history-trigger {
    background: transparent;
  }

  .starter {
    background: transparent;
  }

  .starter:hover {
    background: var(--muted);
    border-color: color-mix(in srgb, var(--foreground) 25%, transparent);
  }
</style>
