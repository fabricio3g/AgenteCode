<svelte:options runes={true} />

<!--
  The agent's background processes for this conversation: what is running,
  where it listens, and its live output. Stop takes the whole process tree.
-->

<script lang="ts">
  import UiInput from '$lib/components/ui/Input.svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Button, PaneHeader, Tooltip } from '$lib/components/ui';
  import { conversationScope } from '$shared/workspace-scope';
  import { t } from 'svelte-i18n';
  import { ChevronRight, ExternalLink, Play, Square, Trash2 } from '$lib/icons';
  import { browserPanelStore as defaultBrowser, type BrowserPanelStore } from '$lib/stores/browser-panel.svelte';
  import { codeWorkspace } from '../workspace.svelte';
  import type { ProcessInfo } from '$shared/code-workspace';

  let { chatId, cwd, browser: browserPanelStore = defaultBrowser }: { browser?: BrowserPanelStore; chatId: string; cwd: string } = $props();

  const processes = $derived([...codeWorkspace.processesFor(chatId)].reverse());
  const selected = $derived(processes.find((p) => p.id === codeWorkspace.selectedProcesses[conversationScope(chatId)]) ?? processes[0] ?? null);
  // eslint-disable-next-line no-control-regex
  const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r(?!\n)/g;
  const output = $derived(selected ? (codeWorkspace.processOutput[selected.id] ?? '').replace(ANSI, '') : '');

  let viewport = $state<HTMLPreElement>();
  // Elapsed times tick while something runs.
  let now = $state(Date.now());
  $effect(() => {
    if (!processes.some((p) => p.status === 'running')) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  let stickToBottom = $state(true);
  let command = $state('');

  $effect(() => {
    if (selected) void codeWorkspace.loadProcessOutput(selected.id);
  });

  $effect(() => {
    void output;
    if (viewport && stickToBottom) viewport.scrollTop = viewport.scrollHeight;
  });

  function onScroll() {
    if (!viewport) return;
    stickToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
  }

  function status(p: ProcessInfo): string {
    if (p.status === 'running') return $t('codeWs.running');
    if (p.status === 'stopped') return $t('codeWs.stopped');
    return $t('codeWs.exited', { values: { code: p.exitCode ?? '?' } });
  }

  function elapsed(p: ProcessInfo): string {
    const ms = (p.endedAt ?? now) - p.startedAt;
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  async function run() {
    const text = command.trim();
    if (!text) return;
    command = '';
    await codeWorkspace.startProcess(chatId, text, cwd);
  }

  function openUrl(url: string) {
    void browserPanelStore.openUrl(url);
  }
</script>

<div class="processes">
  <!-- The list -->
  <div class="proc-list">
    <form class="ui-pill-field" onsubmit={(e) => { e.preventDefault(); void run(); }}>
      <ChevronRight class="size-3 shrink-0 text-muted-foreground" />
      <UiInput
        class={uiClass("font-mono", "ui-local-7dc5fc69")}
        bind:value={command}
        placeholder={$t('codeWs.runPlaceholder')}
        spellcheck="false"
        aria-label={$t('codeWs.runPlaceholder')}
      />
      {#if command.trim()}
        <Tooltip label={$t('codeWs.run')} position="bottom"><UiIconButton label={$t('codeWs.run')} size="xs" type="submit" class={uiClass("  -mr-1.5", "ui-local-7dc5fc69")} ><Play /></UiIconButton></Tooltip>
      {/if}
    </form>
    <ul class="proc-items">
      {#each processes as p (p.id)}
        <li>
          <Button variant="plain"
            type="button"
            class={uiClass("proc-row", "ui-local-7dc5fc69", {"is-active": selected?.id === p.id})}

            title={`${p.command}\n${status(p)} · ${elapsed(p)}`}
            onclick={() => (codeWorkspace.selectedProcesses[conversationScope(chatId)] = p.id)}
          >
            <span class="proc-dot {p.status === 'running' ? 'is-running' : p.status === 'exited' && p.exitCode ? 'is-failed' : ''}"></span>
            <span class="min-w-0 flex-1 truncate font-mono">{p.command}</span>
            <span class="proc-time">{elapsed(p)}</span>
          </Button>
        </li>
      {:else}
        <li class="proc-empty">{$t('codeWs.noProcesses')}</li>
      {/each}
    </ul>
    {#if processes.some((p) => p.status !== 'running')}
      <Button variant="plain" type="button" class={uiClass("proc-clear", "ui-local-7dc5fc69")} onclick={() => void codeWorkspace.clearFinished(chatId)}>
        <Trash2 class="size-3" /> {$t('codeWs.clearFinished')}
      </Button>
    {/if}
  </div>

  <!-- The selected process, inset like the browser's page -->
  <div class="proc-output">
    {#if selected}
      <PaneHeader class="proc-head">
        <span class="min-w-0 flex-1 truncate font-mono text-foreground" title={selected.command}>{selected.command}</span>
        <span class="shrink-0 tabular-nums">{status(selected)} · {elapsed(selected)}</span>
        {#snippet actions()}
          {#each selected.urls as url (url)}
            <Button variant="outline" size="sm" type="button" onclick={() => openUrl(url)} title={$t('codeWs.openInBrowser')}>
              <ExternalLink /> {url.replace(/^https?:\/\//, '')}
            </Button>
          {/each}
          {#if selected.status === 'running'}
            <Button variant="outline" size="sm" class="hover:text-error" type="button" onclick={() => void codeWorkspace.stopProcess(selected.id)}>
              <Square /> {$t('codeWs.stop')}
            </Button>
          {/if}
        {/snippet}
      </PaneHeader>
      <pre
        class="proc-log"
        bind:this={viewport}
        onscroll={onScroll}
      >{output || $t('codeWs.noOutput')}</pre>
    {:else}
      <div class="proc-hint">{$t('codeWs.processesHint')}</div>
    {/if}
  </div>
</div>

<style>
  .processes {
    display: flex;
    height: 100%;
    min-height: 0;
    gap: 0.25rem;
    /* Two insets: the top one keeps the run pill off the dock's tab strip. */
    padding: 2px 4px 4px;
  }

  .proc-list {
    display: flex;
    width: 13.5rem;
    flex-shrink: 0;
    flex-direction: column;
    gap: 0.25rem;
    min-height: 0;
  }

  /* Full-radius hover pills, like the Changes list: a gap keeps them apart. */
  .proc-items {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-height: 0;
    flex: 1;
    overflow-y: auto;
  }

  :global(.proc-row.ui-local-7dc5fc69) {
    display: flex;
    width: 100%;
    height: var(--sidebar-row-h);
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.6rem;
    border-radius: var(--float-row-radius);
    color: var(--muted-foreground);
    font-size: var(--text-sm);
    text-align: left;
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  :global(.proc-row:hover.ui-local-7dc5fc69),
  :global(.proc-row.is-active.ui-local-7dc5fc69) {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .proc-dot {
    width: 0.375rem;
    height: 0.375rem;
    flex-shrink: 0;
    border-radius: var(--radius-full);
    background: var(--muted-foreground);
    opacity: 0.5;
  }
  .proc-dot.is-running {
    background: var(--success);
    opacity: 1;
  }
  .proc-dot.is-failed {
    background: var(--error);
    opacity: 1;
  }

  .proc-time {
    flex-shrink: 0;
    color: var(--muted-foreground);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
  }

  .proc-empty {
    padding: 0.5rem 0.6rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    line-height: 1.55;
  }

  :global(.proc-clear.ui-local-7dc5fc69) {
    display: inline-flex;
    height: 1.5rem;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.6rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  :global(.proc-clear:hover.ui-local-7dc5fc69) {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .proc-output {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
    border-radius: 8px;
    background: var(--muted);
  }

  :global(.proc-head) { font-size: var(--text-xs); }

  .proc-log {
    min-height: 0;
    flex: 1;
    overflow: auto;
    margin: 0;
    /* The head above carries no padding below it, so the first log
       line needs the top inset it never had. */
    padding: 0.35rem 0.75rem 0.6rem;
    white-space: pre;
    color: var(--foreground);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-xs);
    line-height: 1.6;
  }

  .proc-hint {
    display: flex;
    flex: 1;
    align-items: flex-start;
    padding: 0.5rem 0.75rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
</style>
