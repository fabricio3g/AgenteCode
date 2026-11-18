<svelte:options runes={true} />
<script lang="ts">
  import { setContext, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Activity, Bot, ClipboardList, FolderTree, GitCompareArrows, Globe, Image, SquareTerminal, X } from '$lib/icons';
  import type { ChatSession } from '$lib/types/chat';
  import { conversationScope } from '$shared/workspace-scope';
  import { appStore } from '$lib/stores/app.svelte';
  import { workspaceLayout } from '$lib/stores/workspace-layout.svelte';
  import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
  import WorkspaceHost from '$lib/components/layout/WorkspaceHost.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { PaneHeader } from '$lib/components/ui';
  import { displayChatTitle } from '$lib/features/shared/session-title';
  import PanelTabs from '$lib/components/layout/PanelTabs.svelte';
  import type { WorkspacePanel, PanelRenderState } from '$lib/components/layout/workspace-panel';
  import BrowserPanel from '$lib/components/browser/BrowserPanel.svelte';
  import CanvasPanel from '$lib/features/canvas/CanvasPanel.svelte';
  import { canvasBoard, CANVAS_CONTEXT } from '$lib/features/canvas/canvas-board.svelte';
  import ChangesPane from './workspace/ChangesPane.svelte';
  import FileExplorer from './workspace/FileExplorer.svelte';
  import ProcessesView from './workspace/ProcessesView.svelte';
  import PlanPanel from './PlanPanel.svelte';
  import SessionPanel from './SessionPanel.svelte';
  import SubagentView from './SubagentView.svelte';
  import { projectControls } from './workspace/project-controls.svelte';
  import CodeSurface from './CodeSurface.svelte';
  import { latestPlan } from './plan-review';
  import { codeStore } from './code.svelte';
  import { codeWorkspace } from './workspace.svelte';

  // This component is keyed by chat id: every mounted conversation owns a dock,
  // including hidden panels, their scroll, terminal focus and canvas gestures.
  let { chat, split = false, onclose, oncontextmenu }: { chat: ChatSession; split?: boolean; onclose?: () => void; oncontextmenu?: (event: MouseEvent) => void } = $props();
  const chatId = untrack(() => chat.id);
  const scope = conversationScope(chatId);
  const layout = workspaceLayout.scoped(scope);
  const browser = browserPanelStore.forScope(scope);
  setContext(CANVAS_CONTEXT, canvasBoard.forChat(chatId));
  const project = $derived(codeStore.projectById(chat.projectId ?? null));
  const plan = $derived(codeWorkspace.plan?.chatId === chat.id ? codeWorkspace.plan.plan ?? latestPlan(chat.messages) : latestPlan(chat.messages));
  /** The subagent the dock's Subagent pane follows; picked in the session column. */
  let childId = $state<string | null>(null);
  function openChild(id: string) {
    childId = id;
    layout.show('subagent');
  }
  const panels = $derived.by(() => {
    const available = !!project;
    const items: WorkspacePanel[] = [
      { id: 'changes', title: $t('codeWs.changes'), icon: GitCompareArrows, content: changesPanel, region: 'right', available, open: layout.isOpen('changes'), onhide: () => layout.hide('changes') },
      { id: 'files', title: $t('codeWs.files'), icon: FolderTree, content: filesPanel, region: 'right', available, open: layout.isOpen('files'), onhide: () => layout.hide('files') },
      { id: 'plan', title: plan?.title ?? $t('code.plan.title'), icon: ClipboardList, content: planPanel, region: 'right', available, open: layout.isOpen('plan'), onhide: () => layout.hide('plan') },
      { id: 'subagent', title: $t('sessionHud.subagent'), icon: Bot, content: subagentPanel, region: 'right', available: !!childId, open: layout.isOpen('subagent'), onhide: () => layout.hide('subagent') },
      { id: 'browser', title: $t('browser.title'), icon: Globe, content: browserPanel, region: 'right', available: true, open: browser.open, onhide: () => void browser.hide() },
      { id: 'canvas', title: $t('canvas.title'), icon: Image, content: canvasPanel, region: 'right', available: true, open: layout.isOpen('canvas'), onhide: () => layout.hide('canvas') },
      { id: 'processes', title: $t('codeWs.processes'), icon: Activity, content: processesPanel, region: 'bottom', available, open: layout.isOpen('processes'), onhide: () => layout.hide('processes') }
    ];
    for (const term of codeWorkspace.terminalsForScope(scope)) items.push({ id: `terminal:${term.id}`, title: term.title, icon: SquareTerminal, content: terminalPanel, region: 'bottom', available, open: layout.isOpen(`terminal:${term.id}`), onhide: () => layout.hide(`terminal:${term.id}`), actions: [
      { label: $t('codeWs.newTerminal'), run: () => { if (project) void codeWorkspace.newTerminal(project.rootPath, undefined, scope); } },
      { label: $t('codeWs.closeTerminal', { values: { name: term.title } }), run: () => codeWorkspace.closeTerminal(term.id) }
    ] });
    return items;
  });
  let terminalModule: Promise<typeof import('./workspace/TerminalView.svelte')> | undefined;
  const loadTerminal = () => terminalModule ??= import('./workspace/TerminalView.svelte');
</script>

<div class="conversation-workspace" data-conversation-workspace={chat.id}>
  <!-- One conversation: its tools live in the title bar, so there is no second row.
       A split gives every pane its own header, since each needs its own tools. -->
  {#if split}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <PaneHeader class="conversation-header" {oncontextmenu} data-conversation-header={chat.id} title={displayChatTitle(chat)}>
      {#snippet actions()}
        <div class="conversation-tools"><PanelTabs inline {chat} {project} {layout} {browser} /></div>
        <IconButton class="close" label={$t('code.pane.close')} onclick={onclose}><X /></IconButton>
      {/snippet}
    </PaneHeader>
  {/if}
  <WorkspaceHost {panels} {layout}>
    <div class="conversation-row">
      <CodeSurface {chat} />
      {#if project && projectControls.open}<SessionPanel {chat} {project} {layout} activeChild={layout.isOpen('subagent') ? childId : null} onopenchild={openChild} />{/if}
    </div>
  </WorkspaceHost>
</div>

{#snippet changesPanel()}
  {#if project}<ChangesPane embedded chatId={chat.id} projectRoot={project.rootPath} sessionId={chat.codeAgent?.sessionId} />{/if}
{/snippet}
{#snippet filesPanel()}
  {#if project}<FileExplorer {layout} embedded chatId={chat.id} projectRoot={project.rootPath} />{/if}
{/snippet}
{#snippet planPanel()}
  {#if plan}<PlanPanel embedded chatId={chat.id} {plan} />{:else}<p class="p-5 text-xs text-muted-foreground">{$t('workspace.noPlan')}</p>{/if}
{/snippet}
{#snippet subagentPanel()}
  {#if childId}{#key childId}<SubagentView {chat} {childId} />{/key}{/if}
{/snippet}
{#snippet browserPanel(state: PanelRenderState)}
  <BrowserPanel embedded store={browser} exposed={state.exposed && !appStore.settingsScreenOpen} presentationKey={JSON.stringify(state.rect)} chatId={chat.id} />
{/snippet}
{#snippet processesPanel()}
  {#if project}<ProcessesView {browser} chatId={chat.id} cwd={project.rootPath} />{/if}
{/snippet}
{#snippet terminalPanel(state: PanelRenderState)}
  {#await loadTerminal() then { default: TerminalView }}<TerminalView id={state.id.slice('terminal:'.length)} active={state.exposed} focused={state.focused} />{/await}
{/snippet}
{#snippet canvasPanel()}<CanvasPanel chatId={chat.id} />{/snippet}

<style>
  .conversation-workspace { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
  /* The conversation and its session column share the width: neither covers the other. */
  .conversation-row { display: flex; flex: 1; min-width: 0; min-height: 0; container-type: inline-size; }
  /* Too narrow for both (a split, or the dock open on a small window): the
     conversation keeps the room and the column steps aside until it returns. */
  @container (max-width: 46rem) { .conversation-row :global(.session-panel) { display: none; } }
  :global(.conversation-header) { container-type:inline-size; }
  .conversation-tools {display:flex;justify-content:flex-end;min-width:0;flex:0 0 auto;margin-left:auto;}
  @container (max-width:26rem) { :global(.conversation-header .changes-badge) {display:none;} }

</style>
