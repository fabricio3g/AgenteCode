<svelte:options runes={true} />

<!--
  The workspace pane strip in the title bar (or split pane header).

  Unified segmented pill for the 4 primary Code panes (Changes with compact
  diff count, Files, Terminal, Session) plus a single `⋯` popover for secondary
  panes (Browser, Plan, Processes, Canvas, Board) and Turn History. Icon-only
  with instant tooltips so the title bar stays calm and compact.
-->

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import type { Snippet } from 'svelte';
  import {
    Activity,
    ClipboardList,
    FolderTree,
    GitCompareArrows,
    Globe,
    Image,
    LayoutGrid,
    ListChecks,
    MoreHorizontal,
    PanelRight as ContextIcon,
    PanelsTopLeft,
    SquareTerminal
  } from '$lib/icons';
  import { swarmStore, tallyOf } from '$lib/features/code/swarm.svelte';
  import { latestPlan } from '$lib/features/code/plan-review';
  import Menu from '$lib/components/ui/Menu.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { say } from '$lib/copy';
  import type { ChatSession, CodeProject } from '$lib/types/chat';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { codeWorkspace } from '$lib/features/code/workspace.svelte';
  import { workspaceLayout as defaultLayout, type WorkspaceLayoutStore } from '$lib/stores/workspace-layout.svelte';
  import { browserPanelStore as defaultBrowser, type BrowserPanelStore } from '$lib/stores/browser-panel.svelte';
  import { groupedNumber } from '$lib/utils/format';

  let {
    chat = null,
    project = null,
    inline = false,
    layout: workspaceLayout = defaultLayout,
    browser: browserPanelStore = defaultBrowser
  }: {
    inline?: boolean;
    layout?: WorkspaceLayoutStore;
    browser?: BrowserPanelStore;
    chat?: ChatSession | null;
    project?: CodeProject | null;
  } = $props();

  /** Repository tools require a linked project. Tasks only need the conversation. */
  const inCode = $derived(!!chat && !!project);
  const cwd = $derived(project?.rootPath ?? '');
  const run = $derived(chat ? codeStore.runFor(chat.id) : null);
  const changes = $derived(chat ? codeWorkspace.changesFor(chat.id) : null);
  const changeTotals = $derived(
    (changes?.files ?? []).reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 })
  );
  const terminalOpen = $derived(
    codeWorkspace.terminalsForScope(workspaceLayout.scope).some((term) => workspaceLayout.isOpen(`terminal:${term.id}`))
  );
  const remainingTasks = $derived(
    chat ? codeStore.todosFor(chat).filter((todo) => todo.status === 'pending' || todo.status === 'in_progress').length : 0
  );
  const board = $derived(chat ? swarmStore.boardFor(chat.id) : null);
  const boardShown = $derived(!!board && (board.enabled || board.cards.length > 0));
  const boardTally = $derived(tallyOf(board));
  const checkpoints = $derived([...(run?.checkpoints ?? [])].reverse());

  const secondaryOpen = $derived(
    browserPanelStore.open ||
      workspaceLayout.isOpen('plan') ||
      workspaceLayout.isOpen('processes') ||
      workspaceLayout.isOpen('canvas') ||
      (boardShown && workspaceLayout.isOpen('board'))
  );

  let moreOpen = $state(false);

  function compactCount(value: number): string {
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
    return String(value);
  }

  function timeLabel(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function confirmRestore(turnIndex: number) {
    if (!chat) return;
    const chatId = chat.id;
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
      await codeWorkspace.toggleBottom('terminal', cwd, workspaceLayout);
    } catch (error) {
      toastStore.error($t('codeWs.terminalFailed', { values: { reason: (error as Error).message } }));
    }
  }

  async function toggleProcesses() {
    try {
      await codeWorkspace.toggleBottom('processes', cwd, workspaceLayout);
    } catch (error) {
      toastStore.error(String(error));
    }
  }

  function togglePlan() {
    if (!chat) return;
    codeWorkspace.togglePlan(chat.id, latestPlan(chat.messages), workspaceLayout);
  }

  function toggleBrowser() {
    void browserPanelStore.toggle().catch((error) => toastStore.error(String(error)));
  }

  /** Roving focus across the strip, the same grammar the space tabs use. */
  function onKeydown(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button[data-panel-tab]')];
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
  }
</script>

{#snippet pane(id: string, label: string, pressed: boolean, onclick: () => void, icon: typeof Activity, badge: Snippet | null = null)}
  {@const Icon = icon}
  <Tooltip {label} position="bottom">
    <UiIconButton
      label={label}
      title=""
      size="xs"
      type="button"
      class={uiClass('pane-tab titlebar-no-drag', 'ui-local-4e9e0cd8', { 'has-badge': !!badge, 'is-on': pressed })}
      aria-pressed={pressed}
      data-panel-tab={id}
      {onclick}
    >
      <Icon class="size-3.5" aria-hidden="true" />
      {#if badge}{@render badge()}{/if}
    </UiIconButton>
  </Tooltip>
{/snippet}

{#snippet changesBadge()}
  {#if changes?.files.length}
    <span class="pane-badge changes-badge" aria-hidden="true">
      <span class="text-success">+{compactCount(changeTotals.add)}</span>
      <span class="text-error">−{compactCount(changeTotals.del)}</span>
    </span>
  {/if}
{/snippet}

{#snippet tasksBadge()}
  <span class="pane-badge" aria-hidden="true">{groupedNumber(remainingTasks)}</span>
{/snippet}

<div class="pane-strip" class:inline role="toolbar" tabindex="-1" aria-label={$t('workspace.panels')} onkeydown={onKeydown} ondblclick={(event) => event.stopPropagation()}>
  {#if chat}
    <div class="pane-pill">
      {#if inCode}
        {@const changesLabel = changes?.files.length ? `${$t('codeWs.changes')} (+${groupedNumber(changeTotals.add)} −${groupedNumber(changeTotals.del)})` : $t('codeWs.changes')}
        {@render pane('changes', changesLabel, workspaceLayout.isOpen('changes'), () => workspaceLayout.toggle('changes'), GitCompareArrows, changes?.files.length ? changesBadge : null)}
        {@render pane('files', $t('codeWs.files'), workspaceLayout.isOpen('files'), () => workspaceLayout.toggle('files'), FolderTree)}
        {@render pane('terminal', $t('codeWs.terminal'), terminalOpen, () => void toggleTerminal(), SquareTerminal)}
        {@const sessionOpen = workspaceLayout.isOpen('session')}
        <span data-session-toggle>{@render pane('session', sessionOpen ? $t('sessionHud.fold') : $t('sessionHud.open'), sessionOpen, () => workspaceLayout.toggle('session'), PanelsTopLeft)}</span>

        <Menu bind:open={moreOpen} placement="bottom-end" minWidth="15rem" label={$t('workspace.panels')}>
          {#snippet trigger(props)}
            <Tooltip label={$t('workspace.panels')} position="bottom">
              <UiIconButton
                label={$t('workspace.panels')}
                title=""
                size="xs"
                type="button"
                class={uiClass('pane-tab titlebar-no-drag', 'ui-local-4e9e0cd8', { 'is-on': moreOpen || secondaryOpen })}
                data-panel-tab="more"
                {...props}
              >
                <MoreHorizontal class="size-3.5" aria-hidden="true" />
                {#if secondaryOpen}<span class="more-dot" aria-hidden="true"></span>{/if}
              </UiIconButton>
            </Tooltip>
          {/snippet}

          <MenuItem icon={Globe} label={$t('browser.title')} active={browserPanelStore.open} onselect={toggleBrowser} />
          <MenuItem icon={ClipboardList} label={$t('code.plan.title')} active={workspaceLayout.isOpen('plan')} onselect={togglePlan} />
          <MenuItem icon={Activity} label={$t('codeWs.processes')} active={workspaceLayout.isOpen('processes')} onselect={() => void toggleProcesses()} />
          <MenuItem icon={Image} label={$t('canvas.title')} active={workspaceLayout.isOpen('canvas')} onselect={() => workspaceLayout.toggle('canvas')} />
          {#if boardShown}
            <MenuItem
              icon={LayoutGrid}
              label={$t('code.swarm.board')}
              active={workspaceLayout.isOpen('board') && !boardTally.review && !boardTally.working}
              onselect={() => workspaceLayout.toggle('board')}
            >
              <span class="ui-menu-item-text"><span class="truncate">{$t('code.swarm.board')}</span></span>
              {#if boardTally.review || boardTally.working}
                <span class="ml-auto text-xs tabular-nums" class:text-warning={boardTally.review > 0}>{boardTally.review || boardTally.working}</span>
              {/if}
            </MenuItem>
          {/if}

          {#if checkpoints.length}
            <div class="ui-menu-separator" role="separator"></div>
            <p class="px-2.5 pb-1 pt-1 text-xs font-semibold text-muted-foreground">{$t('code.historyTitle')}</p>
            {#each checkpoints as checkpoint (checkpoint.turnIndex)}
              <MenuItem onselect={() => confirmRestore(checkpoint.turnIndex)}>
                <span class="min-w-0 flex-1 truncate">
                  <span class="font-medium text-foreground">{timeLabel(checkpoint.createdAt)}</span>
                  <span class="text-muted-foreground"> · {say.files(checkpoint.fileCount)}</span>
                </span>
                <span class="tabular-nums">
                  <span class="text-success">+{compactCount(checkpoint.additions)}</span>
                  <span class="text-error">−{compactCount(checkpoint.deletions)}</span>
                </span>
              </MenuItem>
            {/each}
          {/if}
        </Menu>
      {:else}
        {@render pane('tasks', $t('code.todosTitle'), workspaceLayout.isOpen('tasks'), () => workspaceLayout.toggle('tasks'), ListChecks, remainingTasks ? tasksBadge : null)}
        {@render pane('browser', $t('browser.title'), browserPanelStore.open, toggleBrowser, Globe)}
        {@render pane('context', $t('context.button'), workspaceLayout.isOpen('context'), () => workspaceLayout.toggle('context'), ContextIcon)}
      {/if}
    </div>
  {/if}
</div>

<style>
  .pane-strip {
    display: flex;
    align-items: center;
    height: 2rem;
    flex: 0 0 auto;
    min-width: 0;
    justify-content: flex-end;
    padding-inline: 0.375rem;
    background: var(--background);
  }
  .pane-strip.inline {
    width: auto;
    padding: 0;
    background: transparent;
  }

  /* One quiet segmented container for all conversation workspace panes. */
  .pane-pill {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: 0.5625rem;
    background: color-mix(in srgb, var(--foreground) 4%, transparent);
    border: 1px solid color-mix(in srgb, var(--foreground) 7%, transparent);
  }

  :global(.pane-tab.ui-local-4e9e0cd8) {
    position: relative;
    transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease), box-shadow var(--motion-instant) var(--motion-ease);
  }
  :global(.pane-tab.is-on.ui-local-4e9e0cd8) {
    background: color-mix(in srgb, var(--foreground) 11%, transparent);
    color: var(--foreground);
    box-shadow: var(--control-shadow);
  }
  :global(.pane-tab.has-badge.ui-local-4e9e0cd8) {
    width: auto;
    gap: 0.3rem;
    padding-inline: 0.4375rem;
    border-radius: var(--radius-sm);
  }

  .pane-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .more-dot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 4px;
    height: 4px;
    border-radius: var(--radius-full);
    background: var(--brand-accent);
  }
</style>
