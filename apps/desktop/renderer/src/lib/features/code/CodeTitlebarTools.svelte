<svelte:options runes={true} />

<!--
  Code tools in the app title bar (no second bar): toggles for the panes
  around the conversation — Changes, Terminal, Processes — each showing its
  live count, then checkpoint history and extensions (compacting is the
  /compact command in the composer). The
  project is already selected in the sidebar and the browser has its own
  title-bar button, so neither repeats here.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Activity, GitCompareArrows, History, SquareTerminal } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { Tooltip } from '$lib/components/ui';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { say } from '$lib/copy';
  import type { ChatSession, CodeProject } from '$lib/types/chat';
  import { codeStore } from './code.svelte';
  import { codeWorkspace } from './workspace.svelte';

  let { chat, project }: { chat: ChatSession; project: CodeProject | null } = $props();

  const run = $derived(codeStore.runFor(chat.id));
  const cwd = $derived(project?.rootPath ?? '');
  const changes = $derived(codeWorkspace.changes);
  const changeTotals = $derived((changes?.files ?? []).reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 }));
  const running = $derived(codeWorkspace.runningCount(chat.id));
  const terminalOpen = $derived(codeWorkspace.layout.bottomOpen && codeWorkspace.bottomTab.startsWith('terminal:'));
  const processesOpen = $derived(codeWorkspace.layout.bottomOpen && codeWorkspace.bottomTab === 'processes');

  let historyOpen = $state(false);

  const checkpoints = $derived([...(run?.checkpoints ?? [])].reverse());

  function timeLabel(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function confirmRestore(turnIndex: number) {
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

  async function toggleTerminal() {
    try {
      await codeWorkspace.toggleBottom('terminal', cwd);
    } catch (error) {
      toastStore.error($t('codeWs.terminalFailed', { values: { reason: (error as Error).message } }));
    }
  }
</script>

{#snippet toggle(label: string, pressed: boolean, onclick: () => void, icon: typeof History, badge: import('svelte').Snippet | null = null)}
  {@const Icon = icon}
  <Tooltip {label} position="bottom">
    <button type="button" class="pane-toggle" class:is-on={pressed} aria-pressed={pressed} aria-label={label} {onclick}>
      <Icon class="size-3.5" />
      {#if badge}{@render badge()}{/if}
    </button>
  </Tooltip>
{/snippet}

{#snippet changesBadge()}
  {#if changes?.files.length}
    <span class="whitespace-nowrap text-[11px] tabular-nums"><span class="text-success">+{changeTotals.add}</span> <span class="text-error">−{changeTotals.del}</span></span>
  {/if}
{/snippet}

{#snippet processesBadge()}
  {#if running}<span class="running-dot" aria-hidden="true"></span><span class="text-[11px] tabular-nums">{running}</span>{/if}
{/snippet}

<div class="code-tools titlebar-no-drag flex items-center gap-0.5" role="toolbar" aria-label={$t('codeWs.panes')}>
  {@render toggle($t('codeWs.changes'), codeWorkspace.layout.changesOpen, () => codeWorkspace.toggleChanges(), GitCompareArrows, changesBadge)}
  {@render toggle($t('codeWs.terminal'), terminalOpen, () => void toggleTerminal(), SquareTerminal)}
  {@render toggle($t('codeWs.processes'), processesOpen, () => void codeWorkspace.toggleBottom('processes', cwd), Activity, processesBadge)}
  {#if checkpoints.length}
    <Menu bind:open={historyOpen} placement="bottom-end" minWidth="16rem" label={$t('code.history')}>
      {#snippet trigger(props)}
        <button type="button" class="pane-toggle" aria-label={$t('code.history')} title={$t('code.history')} {...props}>
          <History class="size-3.5" />
        </button>
      {/snippet}
      <p class="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold text-muted-foreground">{$t('code.historyTitle')}</p>
      {#each checkpoints as checkpoint (checkpoint.turnIndex)}
        <MenuItem onselect={() => confirmRestore(checkpoint.turnIndex)}>
          <span class="min-w-0 flex-1 truncate">
            <span class="font-medium text-foreground">{timeLabel(checkpoint.createdAt)}</span>
            <span class="text-muted-foreground"> · {say.files(checkpoint.fileCount)}</span>
          </span>
          <span class="tabular-nums">
            <span class="text-success">+{checkpoint.additions}</span>
            <span class="text-error">−{checkpoint.deletions}</span>
          </span>
        </MenuItem>
      {/each}
    </Menu>
  {/if}
</div>

<style>
  .pane-toggle {
    display: inline-flex;
    white-space: nowrap;
    align-items: center;
    gap: 0.375rem;
    height: var(--icon-btn);
    min-width: var(--icon-btn);
    justify-content: center;
    padding: 0 0.375rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  .pane-toggle:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  .pane-toggle.is-on {
    background: var(--surface-active);
    color: var(--foreground);
  }
  .pane-toggle:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 30%, transparent);
  }
  .running-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    background: var(--success);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% { opacity: 0.4; }
  }
  @media (prefers-reduced-motion: reduce) {
    .running-dot { animation: none; }
  }
</style>
