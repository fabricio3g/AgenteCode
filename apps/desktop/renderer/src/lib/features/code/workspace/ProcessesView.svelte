<svelte:options runes={true} />

<!--
  The agent's background processes for this conversation: what is running,
  where it listens, and its live output. Stop takes the whole process tree.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ExternalLink, Play, Square, Trash2 } from 'lucide-svelte';
  import { Button } from '$lib/components/ui';
  import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
  import { codeWorkspace } from '../workspace.svelte';
  import type { ProcessInfo } from '$shared/code-workspace';

  let { chatId, cwd }: { chatId: string; cwd: string } = $props();

  const processes = $derived([...codeWorkspace.processesFor(chatId)].reverse());
  const selected = $derived(processes.find((p) => p.id === codeWorkspace.selectedProcessId) ?? processes[0] ?? null);
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

<div class="flex h-full min-h-0">
  <!-- The list -->
  <div class="flex w-56 shrink-0 flex-col border-r border-[var(--border-subtle)]">
    <form class="flex items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1.5" onsubmit={(e) => { e.preventDefault(); void run(); }}>
      <input
        class="min-w-0 flex-1 bg-transparent px-1 text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
        bind:value={command}
        placeholder={$t('codeWs.runPlaceholder')}
        spellcheck="false"
        aria-label={$t('codeWs.runPlaceholder')}
      />
      <Button type="submit" variant="ghost" size="icon-sm" disabled={!command.trim()} aria-label={$t('codeWs.run')} title={$t('codeWs.run')}><Play /></Button>
    </form>
    <ul class="min-h-0 flex-1 overflow-y-auto py-1">
      {#each processes as p (p.id)}
        {@const active = selected?.id === p.id}
        <li>
          <button
            type="button"
            class="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors {active ? 'bg-[var(--surface-active)]' : 'hover:bg-[var(--surface-hover)]'}"
            onclick={() => (codeWorkspace.selectedProcessId = p.id)}
          >
            <span class="flex items-center gap-2">
              <span class="size-1.5 shrink-0 rounded-full {p.status === 'running' ? 'bg-success' : p.status === 'exited' && p.exitCode ? 'bg-error' : 'bg-[var(--text-muted)] opacity-60'}"></span>
              <span class="min-w-0 flex-1 truncate text-[12px] text-foreground" title={p.command}>{p.command}</span>
            </span>
            <span class="pl-3.5 text-[11px] text-muted-foreground">{status(p)} · {elapsed(p)}</span>
          </button>
        </li>
      {:else}
        <li class="px-3 py-4 text-xs leading-relaxed text-muted-foreground">{$t('codeWs.noProcesses')}</li>
      {/each}
    </ul>
    {#if processes.some((p) => p.status !== 'running')}
      <div class="border-t border-[var(--border-subtle)] p-1">
        <Button variant="ghost" size="xs" class="w-full justify-start text-muted-foreground" onclick={() => void codeWorkspace.clearFinished(chatId)}>
          <Trash2 /> {$t('codeWs.clearFinished')}
        </Button>
      </div>
    {/if}
  </div>

  <!-- The selected process -->
  <div class="flex min-w-0 flex-1 flex-col">
    {#if selected}
      <div class="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
        <span class="min-w-0 flex-1 truncate text-[12px] text-foreground" title={selected.command}>{selected.command}</span>
        {#each selected.urls as url (url)}
          <Button variant="outline" size="xs" onclick={() => openUrl(url)} title={$t('codeWs.openInBrowser')}>
            <ExternalLink /> {url.replace(/^https?:\/\//, '')}
          </Button>
        {/each}
        {#if selected.status === 'running'}
          <Button variant="ghost" size="xs" class="text-error" onclick={() => void codeWorkspace.stopProcess(selected.id)}>
            <Square /> {$t('codeWs.stop')}
          </Button>
        {/if}
      </div>
      <pre
        class="min-h-0 flex-1 overflow-auto whitespace-pre px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground"
        bind:this={viewport}
        onscroll={onScroll}
      >{output || $t('codeWs.noOutput')}</pre>
    {:else}
      <div class="flex flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-muted-foreground">
        {$t('codeWs.processesHint')}
      </div>
    {/if}
  </div>
</div>
