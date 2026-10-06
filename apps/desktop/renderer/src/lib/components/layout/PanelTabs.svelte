<svelte:options runes={true} />

<!--
  The workspace pane tabs, in a strip under the title bar.

  They used to sit inside the title bar as icon-only buttons. The Code
  conversation has five panes (Changes, Plan, Terminal, Processes, Canvas) and
  the agent browser is a pane in every space, so that row grew into the
  caption buttons and both groups started competing for the same pixels.
  Splitting it gives each job its own line: the title bar keeps global chrome
  (sidebar, spaces, downloads, theme) and this strip owns the panes.

  They are toggles, not views — several panes can be open at once — so the
  strip is a toolbar with pressed state rather than a tablist. The arrows move
  focus only; Space and Enter toggle, as they do on any button.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { Snippet } from 'svelte';
  import { Activity, ClipboardList, FolderTree, GitCompareArrows, Globe, History, Image, SquareTerminal } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { say } from '$lib/copy';
  import type { ChatSession, CodeProject } from '$lib/types/chat';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { codeWorkspace } from '$lib/features/code/workspace.svelte';
  import ProjectControls from '$lib/features/code/workspace/ProjectControls.svelte';
  import { workspaceLayout as defaultLayout, type WorkspaceLayoutStore } from '$lib/stores/workspace-layout.svelte';
  import { browserPanelStore as defaultBrowser, type BrowserPanelStore } from '$lib/stores/browser-panel.svelte';
  import { latestPlan } from '$lib/features/code/plan-review';
  import { groupedNumber } from '$lib/utils/format';

  let { chat = null, project = null, inline = false, layout: workspaceLayout = defaultLayout, browser: browserPanelStore = defaultBrowser }: { inline?: boolean; layout?: WorkspaceLayoutStore; browser?: BrowserPanelStore; chat?: ChatSession | null; project?: CodeProject | null } = $props();

  /** The Code panes only exist inside an open Code conversation. */
  const inCode = $derived(!!chat && !!project);
  const cwd = $derived(project?.rootPath ?? '');
  const run = $derived(chat ? codeStore.runFor(chat.id) : null);
  const changes = $derived(chat ? codeWorkspace.changesFor(chat.id) : null);
  const changeTotals = $derived((changes?.files ?? []).reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 }));
  const terminalOpen = $derived(codeWorkspace.terminalsForScope(workspaceLayout.scope).some((term) => workspaceLayout.isOpen(`terminal:${term.id}`)));
  const processesOpen = $derived(workspaceLayout.isOpen('processes'));

  let historyOpen = $state(false);

  const checkpoints = $derived([...(run?.checkpoints ?? [])].reverse());

  function timeLabel(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

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

  async function toggleTerminal() {
    try {
      await codeWorkspace.toggleBottom('terminal', cwd, workspaceLayout);
    } catch (error) {
      toastStore.error($t('codeWs.terminalFailed', { values: { reason: (error as Error).message } }));
    }
  }

  /** Roving focus across the strip, the same grammar the space tabs use. */
  function onKeydown(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button[data-panel-tab]')];
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
  }
</script>

{#snippet pane(id: string, label: string, pressed: boolean, onclick: () => void, icon: typeof Activity, badge: Snippet | null = null, text: string | null = null)}
  {@const Icon = icon}
  <Tooltip {label} position="bottom">
    <button type="button" class="ui-icon-button is-sm pane-tab titlebar-no-drag" class:has-badge={!!badge} class:has-label={!!text} class:is-on={pressed} aria-pressed={pressed} aria-label={label} data-panel-tab={id} {onclick}>
      <Icon class="size-3.5" aria-hidden="true" />
      {#if text}<span class="pane-tab-label">{text}</span>{/if}
      {#if badge}{@render badge()}{/if}
    </button>
  </Tooltip>
{/snippet}

{#snippet changesBadge()}
  {#if changes?.files.length}
    <span class="changes-badge" aria-hidden="true"><span class="text-success">+{groupedNumber(changeTotals.add)}</span><span class="text-error">−{groupedNumber(changeTotals.del)}</span></span>
  {/if}
{/snippet}

<div class="pane-strip" class:inline role="toolbar" tabindex="-1" aria-label={$t('workspace.panels')} onkeydown={onKeydown} ondblclick={(event) => event.stopPropagation()}>
  <div class="pane-strip-controls">
    <!-- The branch names the checkout the panes act on, so it leads the strip. -->
    {#if inCode && project && chat}
      <ProjectControls {chat} {project} layout={workspaceLayout}>
        {@render pane('plan', $t('code.plan.title'), workspaceLayout.isOpen('plan'), () => codeWorkspace.togglePlan(chat!.id, latestPlan(chat!.messages), workspaceLayout), ClipboardList)}
        {@render pane('processes', $t('codeWs.processes'), processesOpen, () => void codeWorkspace.toggleBottom('processes', cwd, workspaceLayout), Activity)}
        {@render pane('canvas', $t('canvas.title'), workspaceLayout.isOpen('canvas'), () => workspaceLayout.toggle('canvas'), Image)}
        {@render pane('browser', $t('browser.title'), browserPanelStore.open, () => void browserPanelStore.toggle().catch((error) => toastStore.error(String(error))), Globe)}
      </ProjectControls>
    {/if}
    <div class="pane-strip-tabs">
      {#if inCode && chat}
        <!--
          Three panes are named and four stay icons. Changes, Files and Plan are
          the surfaces a conversation is read through — the ones a new reader
          cannot guess from a glyph — while Terminal, Processes, Canvas and
          Browser are instruments you go looking for by name anyway.
        -->
        {@render pane('changes', $t('codeWs.changes'), workspaceLayout.isOpen('changes'), () => workspaceLayout.toggle('changes'), GitCompareArrows, changesBadge)}
        {@render pane('files', $t('codeWs.files'), workspaceLayout.isOpen('files'), () => workspaceLayout.toggle('files'), FolderTree)}
        {@render pane('terminal', $t('codeWs.terminal'), terminalOpen, () => void toggleTerminal(), SquareTerminal)}
      {/if}
    </div>

    <!-- Checkpoints act on the turn, not on a pane, so they trail the strip. -->
    {#if inCode && checkpoints.length}
      <Menu bind:open={historyOpen} placement="bottom-end" minWidth="16rem" label={$t('code.history')}>
        {#snippet trigger(props)}
          <Tooltip label={$t('code.history')} position="bottom">
            <button type="button" class="ui-icon-button is-sm pane-tab titlebar-no-drag" aria-label={$t('code.history')} {...props}>
              <History class="size-3.5" aria-hidden="true" />
            </button>
          </Tooltip>
        {/snippet}
        <p class="px-2.5 pb-1 pt-1.5 text-xs font-semibold text-muted-foreground">{$t('code.historyTitle')}</p>
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
</div>

<style>
  /* Small instruments stay visible; less frequent actions live in the project card. */
  .pane-strip {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    height: 2rem;
    flex: 0 0 auto;
    min-width: 0;
    width: 100%;
    justify-content: flex-end;
    padding-inline: 0.375rem;
    container-type: inline-size;
    background: var(--background);
  }
  .pane-strip.inline {width:auto;container-type:normal;padding:0;background:transparent;}
  /* Inside the title bar a scroll container would swallow the no-drag regions of its buttons. */
  .pane-strip.inline .pane-strip-tabs { overflow: visible; }
  .pane-strip-controls {
    display: flex;
    min-width: 0;
    max-width: 100%;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
  }
  .pane-strip-tabs {
    display: flex;
    min-width: 0;
    flex: 0 1 auto;
    gap: 0.125rem;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .pane-strip-tabs::-webkit-scrollbar { display: none; }

  /*
   * The same circular icon button as the title bar (`.ui-icon-button`), with
   * one addition: a pane that carries a live count — or its name — widens into
   * a pill so the text has a home instead of overprinting the glyph.
   */
  .pane-tab {
    position: relative;
    transition: width var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  .pane-tab.has-badge,
  .pane-tab.has-label {
    width: auto;
    gap: 0.3rem;
    padding-inline: 0.4rem;
    border-radius: var(--radius-full);
  }

  .pane-tab-label {
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  /*
   * The strip is the app's whole control surface, so the names stay while there
   * is room and fold back into their icons — which keep the tooltip and the
   * aria-label — when there is not. `container-type` on the strip was declared
   * for exactly this and never had a rule using it; the icons themselves never
   * disappear, so no pane becomes unreachable.
   */
  @container (max-width: 46rem) {
    .pane-tab-label {
      display: none;
    }
  }

  .changes-badge {
    display: inline-flex;
    gap: 0.25rem;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .pane-tab { transition: none; }
  }
</style>
