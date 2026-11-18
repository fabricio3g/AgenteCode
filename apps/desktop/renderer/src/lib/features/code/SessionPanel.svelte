<svelte:options runes={true} />

<!--
  The session column: everything about this conversation that is not the
  conversation itself, docked beside it so the transcript and the composer
  share their width with it instead of being covered. Subagents are not here:
  they have their bubbles in the transcript and their pill over the composer.

  One place for what used to be four — the floating project card, the Tasks
  pane, the Context pane and the composer's ring — top to bottom in the order
  people look: which project and which checkout, how full the context is,
  what the agent is working through, and the project's scripts. Labels hard
  left, values hard right; empty sections are not drawn.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Activity, ClipboardList, Code, FolderOpen, GitCompareArrows, Image, Play, Plus, Upload, X } from '$lib/icons';
  import type { ChatSession, CodeProject } from '$lib/types/chat';
  import type { WorkspaceLayoutStore } from '$lib/stores/workspace-layout.svelte';
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
  import TasksPanel from './TasksPanel.svelte';
  import BranchMenu from './workspace/BranchMenu.svelte';
  import { openFileInEditor } from './workspace/editor-actions';
  import { projectControls } from './workspace/project-controls.svelte';

  let { chat, project, layout }: { chat: ChatSession; project: CodeProject; layout: WorkspaceLayoutStore } = $props();

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

  /* The Tasks pane, embedded: the column already scrolls and pads. */
  .tasks :global(.pane-body) { padding: 0; overflow: visible; }

  .script-row { display: flex; align-items: center; gap: 0.25rem; }
  .add { color: var(--muted-foreground); }
  .add :global(svg) { margin-left: 0.3125rem; flex-shrink: 0; }
  .script-form { display: grid; gap: 0.375rem; padding: 0.25rem 0.5rem; }
  .script-form > div { display: flex; justify-content: flex-end; gap: 0.375rem; }
</style>
