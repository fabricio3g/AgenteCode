<svelte:options runes={true} />

<!--
  The session column: everything about this conversation that is not the
  conversation itself, docked beside it so the transcript and the composer
  share their width with it instead of being covered. Subagents are not here:
  they have their bubbles in the transcript and their pill over the composer.

  One place for what used to be four — the floating project card, the Tasks
  pane, the Context pane and the composer's ring — top to bottom in the order
  people look: which project and which checkout, how full the context is,
  what the agent is working through, what is running (commands, and the
  servers among them with their address), what is connected (computer use,
  MCP servers), and the project's scripts. The branch carries its pull
  request: the PR with its checks, or how far it leads its base and a link to
  open one. Labels hard left, values hard right; defaults stay grey and only
  a state worth a look takes colour; empty sections are not drawn.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Activity, ClipboardList, Code, ExternalLink, FolderOpen, GitCompareArrows, GitPullRequest, Image, Monitor, Play, Plug, Plus, Square, Upload, X } from '$lib/icons';
  import type { ChatSession, CodeProject } from '$lib/types/chat';
  import type { WorkspaceLayoutStore } from '$lib/stores/workspace-layout.svelte';
  import type { BrowserPanelStore } from '$lib/stores/browser-panel.svelte';
  import type { PullRequestState } from '$shared/code-workspace';
  import { conversationScope } from '$shared/workspace-scope';
  import { computerStore } from '$lib/features/computer/computer.svelte';
  import { Button, IconButton } from '$lib/components/ui';
  import UiInput from '$lib/components/ui/Input.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import { shortModel } from '$lib/utils/format';
  import { formatToolDuration } from '$lib/utils/tool-ui';
  import ContextUsageRing from '$lib/features/chat/composer/ContextUsageRing.svelte';
  import { codeStore } from './code.svelte';
  import { codeWorkspace } from './workspace.svelte';
  import { conversationSpend, spendCostLabel } from './accounting';
  import { latestPlan } from './plan-review';
  import { gitPullRequest, mcpStatus, type McpServer } from './code-ipc';
  import TasksPanel from './TasksPanel.svelte';
  import BranchMenu from './workspace/BranchMenu.svelte';
  import { openFileInEditor } from './workspace/editor-actions';
  import { projectControls } from './workspace/project-controls.svelte';

  let { chat, project, layout, browser }: { chat: ChatSession; project: CodeProject; layout: WorkspaceLayoutStore; browser: BrowserPanelStore } = $props();

  const run = $derived(codeStore.runFor(chat.id));
  const branch = $derived(codeWorkspace.branchFor(project.rootPath));
  const changes = $derived(codeWorkspace.changesFor(chat.id)?.files ?? []);
  const churn = $derived(changes.reduce((sum, file) => ({ add: sum.add + file.additions, del: sum.del + file.deletions }), { add: 0, del: 0 }));

  // The composer's own source: the last call's prompt is the context footprint.
  const usage = $derived(run?.usage ?? [...chat.messages].reverse().find((message) => message.metadata?.codeUsage)?.metadata?.codeUsage);
  const context = $derived(usage && usage.promptTokens > 0 && (usage.contextWindow ?? 0) > 0 ? usage : null);
  const spend = $derived(conversationSpend(chat.messages, run ?? undefined));
  const model = $derived([...chat.messages].reverse().find((message) => message.metadata?.modelName)?.metadata?.modelName);
  const worked = $derived(chat.messages.reduce((sum, { metadata: m }) => sum + (m?.codeElapsedMs ?? 0), 0));

  const todos = $derived(codeStore.todosFor(chat));

  // What this conversation has running; a process that printed a local
  // address is a server, and its address is the row's link.
  const running = $derived(codeWorkspace.processesFor(chat.id).filter((process) => process.status === 'running'));
  let now = $state(Date.now());
  $effect(() => {
    if (!running.length) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  function showProcess(id: string) {
    codeWorkspace.selectedProcesses[conversationScope(chat.id)] = id;
    layout.show('processes', 'bottom');
  }
  const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

  // The branch as a pull request, and what is connected. Both are read when
  // the column opens, when a turn settles, when the branch changes and when
  // the window comes back — never polled.
  let pr = $state<PullRequestState | null>(null);
  let servers = $state<McpServer[]>([]);
  async function refresh(root: string) {
    const [nextPr, nextServers] = await Promise.all([
      gitPullRequest(root).catch(() => null),
      mcpStatus(root).catch(() => [] as McpServer[])
    ]);
    if (root !== project.rootPath) return;
    pr = nextPr;
    servers = nextServers;
  }
  $effect(() => {
    const root = project.rootPath;
    void branch?.current;
    if (run?.running) return;
    void refresh(root);
  });
  $effect(() => {
    const onFocus = () => void refresh(project.rootPath);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });
  const openExternal = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

  const computer = $derived(computerStore.available ? computerStore.state : null);
  const computerLive = $derived(!!computer && ['active', 'preparing', 'requesting'].includes(computer.phase));
  const computerTone = $derived(computerLive ? 'live' : computer?.phase === 'paused' ? 'warn' : '');
  const mcpTone = (status: McpServer['status']) => status === 'failed' ? 'error' : status === 'needs_approval' ? 'warn' : status === 'connecting' ? 'live' : '';

  // Scripts: the project's own commands, one click to run in Processes.
  type Script = { name: string; command: string };
  const KEY = 'agente.projectScripts';
  function readScripts(): Record<string, Script[]> {
    try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
  }
  let scripts = $state(readScripts());
  let adding = $state(false), name = $state(''), command = $state(''), busy = $state(false);
  function saveScripts() { try { localStorage.setItem(KEY, JSON.stringify(scripts)); } catch { /* Session-only. */ } }
  function addScript() {
    if (!name.trim() || !command.trim()) return;
    scripts[project.id] = [...(scripts[project.id] ?? []), { name: name.trim(), command: command.trim() }];
    saveScripts(); name = command = ''; adding = false;
  }
  async function runCommand(value: string) {
    if (busy) return;
    busy = true;
    try { await codeWorkspace.startProcess(chat.id, value, project.rootPath); layout.show('processes', 'bottom'); }
    catch (error) { toastStore.error(String(error)); }
    finally { busy = false; }
  }

  const tools = $derived([
    { id: 'editor', label: $t('projectControls.openEditor'), icon: Code, run: () => void openFileInEditor(project.rootPath, '.', undefined, layout.scope) },
    { id: 'reveal', label: copy.actions.reveal, icon: FolderOpen, run: () => void codeStore.revealProject(project.id).catch((error) => toastStore.error(String(error))) },
    { id: 'plan', label: $t('code.plan.title'), icon: ClipboardList, run: () => codeWorkspace.togglePlan(chat.id, latestPlan(chat.messages), layout) },
    { id: 'processes', label: $t('codeWs.processes'), icon: Activity, run: () => void codeWorkspace.toggleBottom('processes', project.rootPath, layout) },
    { id: 'canvas', label: $t('canvas.title'), icon: Image, run: () => layout.toggle('canvas') }
  ]);
</script>

<aside class="session-panel" aria-label={$t('sessionHud.title')} data-project-controls={chat.id}>
  <header class="head">
    <FolderOpen class="size-3.5 shrink-0" />
    <span class="name" title={project.rootPath}>{project.rootName}</span>
    <IconButton quiet size="xs" label={$t('sessionHud.fold')} onclick={() => projectControls.set(false)}><X /></IconButton>
  </header>
  <p class="path" title={project.rootPath}>{project.rootPath}</p>
  <div class="tools">
    {#each tools as tool (tool.id)}
      <Tooltip label={tool.label} position="bottom"><IconButton quiet size="xs" label={tool.label} onclick={tool.run}><tool.icon /></IconButton></Tooltip>
    {/each}
  </div>

  <section class="facts">
    <div class="fact branch"><BranchMenu projectRoot={project.rootPath} />
      {#if branch?.source === 'git'}<Tooltip label={$t('projectControls.push')} position="bottom"><IconButton quiet size="xs" label={$t('projectControls.push')} disabled={busy} onclick={() => void runCommand('git push')}><Upload /></IconButton></Tooltip>{/if}
    </div>
    {#if pr?.pr}
      {@const item = pr.pr}
      <button type="button" class="fact link" title={item.title} onclick={() => openExternal(item.url)} data-pull-request={item.number}>
        <span class="label"><GitPullRequest class="size-3.5" />{$t('sessionHud.pr', { values: { n: item.number } })}{#if item.draft || item.state !== 'OPEN'}<span class="muted">· {item.draft ? $t('sessionHud.prDraft') : $t(`sessionHud.prState.${item.state}`)}</span>{/if}</span>
        {#if item.checks !== 'none'}<span class="state" data-tone={item.checks === 'fail' ? 'error' : item.checks === 'pending' ? 'live' : ''}><span class="dot"></span>{$t(`sessionHud.checks.${item.checks}`)}</span>{/if}
      </button>
    {:else if pr && pr.ahead > 0 && pr.base}
      {@const compare = pr.compareUrl}
      <div class="fact">
        <span class="label"><GitPullRequest class="size-3.5" />{$t('sessionHud.ahead', { values: { n: pr.ahead, base: pr.base } })}</span>
        {#if compare}<button type="button" class="action" onclick={() => openExternal(compare)}>{$t('sessionHud.createPr')}<ExternalLink class="size-3" /></button>{/if}
      </div>
    {/if}
    {#if changes.length}
      <button type="button" class="fact link" onclick={() => layout.show('changes')}>
        <span class="label"><GitCompareArrows class="size-3.5" />{$t('sessionHud.changes')}</span>
        <span class="pane-churn"><span class="text-success">+{churn.add}</span><span class="text-error">−{churn.del}</span><span class="muted">· {changes.length}</span></span>
      </button>
    {/if}
    {#if context}
      <div class="fact"><span class="label">{$t('sessionHud.context')}</span><ContextUsageRing showLabel usedTokens={context.promptTokens} maxTokens={context.contextWindow ?? 0} breakdown={context.breakdown} {spend} /></div>
    {/if}
    {#if spend.costUsd > 0}
      <div class="fact"><span class="label">{$t('sessionHud.spend')}</span><span class="value">{spendCostLabel(spend)}</span></div>
    {/if}
    {#if model}
      <div class="fact"><span class="label">{$t('sessionHud.model')}</span><span class="value" title={model}>{shortModel(model)}</span></div>
    {/if}
    {#if worked >= 1000}
      <div class="fact"><span class="label">{$t('context.worked')}</span><span class="value">{formatToolDuration(worked)}</span></div>
    {/if}
  </section>

  {#if todos.length}
    <div class="tasks"><TasksPanel {chat} /></div>
  {/if}

  {#if running.length}
    <section>
      <h3 class="pane-heading">{$t('sessionHud.running')}<span class="pane-count">{running.length}</span></h3>
      {#each running as process (process.id)}
        <div class="item" data-running-process={process.id}>
          <div class="item-row">
            <button type="button" class="item-main" title={process.command} onclick={() => showProcess(process.id)}>
              <span class="dot live" aria-hidden="true"></span>
              <span class="command">{process.command}</span>
              <span class="time">{formatToolDuration(Math.max(0, now - process.startedAt))}</span>
            </button>
            <IconButton quiet size="xs" label={$t('codeWs.stop')} onclick={() => void codeWorkspace.stopProcess(process.id)}><Square /></IconButton>
          </div>
          {#if process.urls[0]}
            {@const url = process.urls[0]}
            <!-- A server: its address on its own line, under the command. -->
            <button type="button" class="chip" title={$t('codeWs.openInBrowser')} onclick={() => void browser.openUrl(url)}><ExternalLink class="size-3" />{host(url)}</button>
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  {#if computer || servers.length}
    <section>
      <h3 class="pane-heading">{$t('sessionHud.connections')}</h3>
      {#if computer}
        <div class="fact" title={computer.task || undefined}>
          <span class="label"><Monitor class="size-3.5" />{$t('sessionHud.computerUse')}</span>
          <span class="state" data-tone={computerTone}><span class="dot"></span>{computerLive ? computer.activity || $t('sessionHud.computerActive') : computer.phase === 'paused' ? $t('sessionHud.computerPaused') : $t('sessionHud.computerReady')}</span>
        </div>
      {/if}
      {#each servers as server (server.name)}
        <div class="fact" title={server.error ?? server.target}>
          <span class="label"><Plug class="size-3.5" /><span class="name-text">{server.name}</span></span>
          <span class="state" data-tone={mcpTone(server.status)}><span class="dot"></span>{server.status === 'ready' ? $t('sessionHud.mcpTools', { values: { n: server.tools } }) : $t(`sessionHud.mcp.${server.status}`)}</span>
        </div>
      {/each}
    </section>
  {/if}

  <section>
    {#if scripts[project.id]?.length || adding}<h3 class="pane-heading">{$t('sessionHud.scripts')}</h3>{/if}
    {#each scripts[project.id] ?? [] as script, index (index)}
      <div class="script-row">
        <button type="button" class="pane-row" disabled={busy} title={script.command} onclick={() => void runCommand(script.command)}>
          <span class="pane-row-tile" aria-hidden="true"><Play class="size-3" /></span><span class="pane-row-label">{script.name}</span>
        </button>
        <IconButton quiet size="xs" label={copy.actions.remove} onclick={() => { scripts[project.id] = scripts[project.id].filter((_, i) => i !== index); saveScripts(); }}><X /></IconButton>
      </div>
    {/each}
    {#if adding}
      <form class="script-form" onsubmit={(event) => { event.preventDefault(); addScript(); }}>
        <UiInput bind:value={name} placeholder={$t('projectControls.scriptName')} aria-label={$t('projectControls.scriptName')} />
        <UiInput bind:value={command} placeholder="npm run dev" aria-label={$t('projectControls.command')} />
        <div><Button size="xs" variant="ghost" onclick={() => adding = false}>{copy.actions.cancel}</Button><Button size="xs" type="submit" disabled={!name.trim() || !command.trim()}>{copy.actions.save}</Button></div>
      </form>
    {:else}
      <button type="button" class="pane-row add" data-keep-open onclick={() => adding = true}><Plus class="size-3.5" /><span class="pane-row-label">{$t('projectControls.addScript')}</span></button>
    {/if}
  </section>
</aside>

<style>
  /* A column, not a card: one hairline against the conversation, no radius. */
  .session-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: clamp(15rem, 26%, 18.5rem);
    flex-shrink: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 0.75rem 0.625rem 1rem;
    border-left: 1px solid var(--border-subtle);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    scrollbar-width: thin;
  }
  .head { display: flex; align-items: center; gap: 0.5rem; padding-left: 0.5rem; color: var(--foreground); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 550; }
  .path { margin: -0.75rem 0 0; padding: 0 0.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--text-xs); }
  .tools { display: flex; gap: 0.125rem; margin-top: -0.375rem; padding-left: 0.25rem; }

  .facts { display: flex; flex-direction: column; gap: 0.125rem; }
  .fact { display: flex; min-width: 0; min-height: 1.75rem; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0 0.5rem; border-radius: var(--float-row-radius); }
  .fact.branch { padding-left: 0; }
  .fact .label { display: inline-flex; align-items: center; gap: 0.375rem; flex-shrink: 0; }
  .fact .value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--foreground); font-variant-numeric: tabular-nums; }
  .link { width: 100%; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; transition: background-color var(--motion-instant) var(--motion-ease); }
  .link:hover { background: var(--float-row-hover); }
  .muted { color: var(--muted-foreground); }

  .action { display: inline-flex; flex-shrink: 0; align-items: center; gap: 0.25rem; padding: 0.125rem 0.5rem; border: 0; border-radius: var(--radius-full); background: color-mix(in srgb, var(--foreground) 7%, transparent); color: var(--foreground); font: inherit; cursor: pointer; transition: background-color var(--motion-instant) var(--motion-ease); }
  .action:hover { background: color-mix(in srgb, var(--foreground) 12%, transparent); }

  /* A state: one dot and a word. Grey by default; colour only when it needs a look. */
  .state { display: inline-flex; min-width: 0; align-items: center; gap: 0.375rem; overflow: hidden; color: var(--muted-foreground); white-space: nowrap; text-overflow: ellipsis; }
  .dot { width: 0.4375rem; height: 0.4375rem; flex-shrink: 0; border-radius: var(--radius-full); background: color-mix(in srgb, var(--muted-foreground) 60%, transparent); }
  .state[data-tone='live'] { color: var(--foreground); }
  .state[data-tone='live'] .dot, .dot.live { background: var(--brand-accent); }
  .state[data-tone='warn'] .dot { background: var(--warning); }
  .state[data-tone='error'] { color: var(--destructive); }
  .state[data-tone='error'] .dot { background: var(--destructive); }
  .name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* A running command: the row opens its output; the address and Stop sit on the right edge. */
  .item { display: flex; min-width: 0; flex-direction: column; align-items: flex-start; }
  .item-row { display: flex; width: 100%; min-width: 0; align-items: center; gap: 0.25rem; }
  .item-main { display: flex; flex: 1; min-width: 0; height: 1.75rem; align-items: center; gap: 0.5rem; padding: 0 0.5rem; border: 0; border-radius: var(--float-row-radius); background: none; color: var(--foreground); font: inherit; text-align: left; cursor: pointer; transition: background-color var(--motion-instant) var(--motion-ease); }
  .item-main:hover { background: var(--float-row-hover); }
  .command { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
  .time { flex-shrink: 0; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
  .chip { display: inline-flex; align-items: center; gap: 0.3125rem; max-width: calc(100% - 1.5rem); margin: 0 0 0.25rem 1.5rem; overflow: hidden; padding: 0.125rem 0.5rem; border: 0; border-radius: var(--radius-full); background: color-mix(in srgb, var(--brand-accent) 14%, transparent); color: var(--foreground); font: inherit; font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .chip:hover { background: color-mix(in srgb, var(--brand-accent) 22%, transparent); }

  /* The Tasks pane, embedded: the column already scrolls and pads. */
  .tasks :global(.pane-body) { padding: 0; overflow: visible; }

  .script-row { display: flex; align-items: center; gap: 0.25rem; }
  .add { color: var(--muted-foreground); }
  .add :global(svg) { margin-left: 0.3125rem; flex-shrink: 0; }
  .script-form { display: grid; gap: 0.375rem; padding: 0.25rem 0.5rem; }
  .script-form > div { display: flex; justify-content: flex-end; gap: 0.375rem; }
</style>
