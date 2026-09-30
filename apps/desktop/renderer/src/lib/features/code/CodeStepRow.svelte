<svelte:options runes={true} />

<!--
  One agent step in the Code transcript, shaped by what the tool did:
  commands read like a terminal (the command, then its streaming output),
  edits show their +/− counts with a link to the Changes pane, approvals
  show a colored diff with Allow / Deny. Other tools are a quiet one-liner
  that expands to its details.
-->

<script lang="ts">
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { AlertCircle, Check, ChevronRight, FilePen, FileSearch, Globe, Loader2, Search, Square, SquareTerminal, Wrench, XCircle } from 'lucide-svelte';
  import type { AgentStep } from '$lib/types/chat';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { formatToolDuration } from '$lib/utils/tool-ui';
  import { copy } from '$lib/copy';
  import { codeWorkspace } from './workspace.svelte';
  import { codeStore } from './code.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { stepKind } from './activity';

  let { step, chatId }: { step: AgentStep; chatId?: string } = $props();

  const OUTPUT_LIMIT = 32_768;

  const tool = $derived(step.toolName ?? '');
  const isRunning = $derived(step.status === 'running' || step.status === 'pending');
  const isApproval = $derived(step.status === 'awaiting_approval' || approvalsStore.items.some((a) => a.id === step.id));
  const isError = $derived(step.status === 'error');
  const isCommand = $derived(stepKind(step) === 'command');
  const isEdit = $derived(stepKind(step) === 'edit');
  const adds = $derived(step.diffStats?.reduce((s, d) => s + d.additions, 0) || 0);
  const dels = $derived(step.diffStats?.reduce((s, d) => s + d.deletions, 0) || 0);
  const looksLikeDiff = (text: string) => /^(---|\+\+\+|@@)/m.test(text);
  const body = $derived.by(() => {
    if (isApproval || isError) return step.detail || step.output || '';
    return step.output || '';
  });

  let expanded = $state(false);
  let outputElement = $state<HTMLPreElement>();
  let followOutput = $state(true);
  $effect(() => {
    void body;
    if (isRunning && followOutput) void tick().then(() => { if (outputElement) outputElement.scrollTop = outputElement.scrollHeight; });
  });
  let userToggled = $state(false);
  $effect(() => {
    // Routine output opens on demand; approvals and failures need eyes immediately.
    if (!userToggled) expanded = isApproval || isError;
  });

  // Live elapsed time while running.
  let startedAt: number | null = null;
  let elapsed = $state<number | undefined>(undefined);
  $effect(() => {
    if (!isRunning) return;
    startedAt ??= Date.now();
    const timer = setInterval(() => (elapsed = Date.now() - (startedAt ?? Date.now())), 250);
    return () => clearInterval(timer);
  });
  const duration = $derived(elapsed !== undefined ? formatToolDuration(elapsed) : '');

  const Icon = $derived.by(() => {
    if (isRunning) return Loader2;
    if (isApproval) return AlertCircle;
    if (isError) return XCircle;
    if (isCommand) return SquareTerminal;
    if (isEdit) return FilePen;
    if (tool === 'read' || tool === 'ls') return FileSearch;
    if (tool === 'grep') return Search;
    if (tool.startsWith('browser_')) return Globe;
    if (step.status === 'done') return Check;
    return Wrench;
  });

  function toggle() {
    if (!body && !isApproval && !isRunning) return;
    userToggled = true;
    expanded = !expanded;
  }

  function viewChanges() {
    const path = step.diffStats?.[0]?.path ?? step.fileChanges?.[0]?.path ?? step.detail ?? '';
    if (path) codeWorkspace.showFileInChanges(path);
  }

  function diffLineClass(line: string): string {
    if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
    if (line.startsWith('@@')) return 'hunk';
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    return '';
  }
</script>

<!-- A settled approval says nothing the tool's own row doesn't: hide it. -->
{#if !(step.type === 'approval' && !isApproval)}
<div class="step" class:is-approval={isApproval} class:is-error={isError} class:is-open={expanded}>
  <div class="flex items-center">
  <button type="button" class="step-head" onclick={toggle} aria-expanded={body || isApproval || isRunning ? expanded : undefined} disabled={!body && !isApproval && !isRunning}>
    <Icon class="step-icon size-3.5 shrink-0 {isRunning ? 'animate-spin' : ''}" />
    <span class="min-w-0 flex-1 truncate text-left">
      <span class="font-medium text-foreground">{step.label}</span>
      {#if step.detail && !isApproval}
        <span class="ml-1.5 {isCommand ? 'font-mono text-[11.5px]' : ''} text-muted-foreground">{step.detail.split('\n')[0]}</span>
      {/if}
    </span>
    {#if adds || dels}
      <span class="shrink-0 font-mono text-[11px] tabular-nums">
        {#if adds}<span class="text-success">+{adds}</span>{/if}
        {#if dels}<span class="ml-1 text-error">−{dels}</span>{/if}
      </span>
    {/if}
    {#if isRunning && duration}<span class="shrink-0 text-[11px] tabular-nums text-muted-foreground">{duration}</span>{/if}
    {#if body || isApproval}
      <ChevronRight class="size-3.5 shrink-0 text-muted-foreground transition-transform {expanded ? 'rotate-90' : ''}" />
    {/if}
  </button>
  {#if isEdit && step.status === 'done' && (adds || dels || step.fileChanges?.length)}
    <button type="button" class="view-link shrink-0 px-2" onclick={viewChanges}>{$t('codeWs.viewChanges')}</button>
  {/if}
  {#if isRunning && isCommand && chatId}<button type="button" class="view-link shrink-0 px-2" aria-label={$t('code.stopCommand')} title={$t('code.stopCommand')} onclick={() => { if (chatId) void codeStore.stop(chatId).catch((error) => toastStore.error(String(error))); }}><Square class="size-3" /></button>{/if}
  </div>

  {#if expanded}
    <div class="step-body">
      {#if body && looksLikeDiff(body)}
        <pre class="diff-text">{#each body.slice(0, OUTPUT_LIMIT).split('\n') as line, index (index)}<span class="dl {diffLineClass(line)}">{line || ' '}</span>{/each}</pre>
      {:else if body}
        <pre bind:this={outputElement} onscroll={() => { if (outputElement) followOutput = outputElement.scrollHeight - outputElement.scrollTop - outputElement.clientHeight < 24; }} class="out" class:is-terminal={isCommand} class:text-error={isError && !isCommand}>{body.slice(-OUTPUT_LIMIT)}{#if isRunning && isCommand}<span class="caret"></span>{/if}</pre>
      {:else if isRunning}
        <p class="text-xs text-muted-foreground">{isCommand && /\|\s*tail\b/.test(step.detail || '') ? 'This pipe prints its tail when the command finishes.' : 'Waiting for output…'}</p>
      {/if}
      {#if isApproval}
        <div class="flex items-center gap-2 pt-2">
          <button type="button" class="approve-btn" onclick={() => approvalsStore.resolve(step.id, false)}>{copy.tool.deny}</button>
          <button type="button" class="approve-btn primary" onclick={() => approvalsStore.resolve(step.id, true)}>{copy.tool.allow}</button>
        </div>
      {/if}
    </div>
  {/if}
</div>
{/if}

<style>
  .step {
    border-radius: 0.625rem;
  }
  .step.is-approval {
    border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border));
    background: color-mix(in srgb, var(--warning) 5%, transparent);
  }
  .step-head {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.625rem;
    font-size: 12.5px;
    color: var(--muted-foreground);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .step-head:not(:disabled):hover {
    background: var(--surface-hover);
  }
  .step-head:disabled {
    cursor: default;
  }
  .step.is-error :global(.step-icon) {
    color: var(--error);
  }
  .step.is-approval :global(.step-icon) {
    color: var(--warning);
  }
  .view-link {
    font-size: 11px;
    color: var(--muted-foreground);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .view-link:hover {
    color: var(--foreground);
  }
  /* Output sits under the title text (past the icon), with air above and below. */
  .step-body {
    padding: 0.375rem 0.5rem 0.75rem 1.875rem;
  }
  .step.is-open + :global(.step) {
    margin-top: 0.25rem;
  }
  pre {
    margin: 0;
    max-height: 18rem;
    overflow: auto;
    border-radius: 0.5rem;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    line-height: 1.55;
  }
  .out {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 0.5rem 0.625rem;
    background: var(--muted);
    color: var(--foreground);
  }
  .out.is-terminal {
    white-space: pre;
    overflow-wrap: normal;
  }
  .diff-text {
    padding: 0.375rem 0;
    background: var(--muted);
  }
  .dl {
    display: block;
    padding: 0 0.625rem;
    white-space: pre;
    color: var(--foreground);
  }
  .dl.add {
    background: color-mix(in srgb, var(--success) 13%, transparent);
  }
  .dl.del {
    background: color-mix(in srgb, var(--error) 12%, transparent);
  }
  .dl.hunk,
  .dl.meta {
    color: var(--muted-foreground);
  }
  .caret {
    display: inline-block;
    width: 0.5em;
    height: 1em;
    margin-left: 1px;
    vertical-align: text-bottom;
    background: var(--foreground);
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    50% { opacity: 0; }
  }
  .approve-btn {
    height: 1.75rem;
    padding: 0 0.75rem;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 500;
    color: var(--foreground);
    border: 1px solid var(--border);
    background: var(--background);
  }
  .approve-btn:hover {
    background: var(--surface-hover);
  }
  .approve-btn.primary {
    border-color: var(--primary);
    background: var(--primary);
    color: var(--primary-fg);
  }
  .approve-btn.primary:hover {
    opacity: 0.9;
  }
  @media (prefers-reduced-motion: reduce) {
    .caret { animation: none; }
  }
</style>
