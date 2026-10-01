<svelte:options runes={true} />

<!--
  One tool call in a work block, read like assistant-ui's tool timeline: an
  icon for the kind of work, the verb, and what it touched as a mono chip —
  "Run  npm test", "Edit  src/app.ts  +14 −3". It opens to what it did:
  commands as a terminal block (the command, its streaming output), edits as
  a diff card per file, approvals as the diff with Allow / Deny, other tools
  as their input and result. A presented plan opens in the right dock.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { AlertCircle, Bot, ChevronRight, FilePen, FileText, FolderOpen, Globe, ListChecks, Loader2, Search, Square, SquareTerminal, Wrench, XCircle } from 'lucide-svelte';
  import type { AgentStep } from '$lib/types/chat';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { formatToolDuration } from '$lib/utils/tool-ui';
  import { copy } from '$lib/copy';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { codeWorkspace } from './workspace.svelte';
  import { codeStore } from './code.svelte';
  import { stepKind } from './activity';
  import { parsePlan } from './plan-review';
  import { looksLikePatch } from './patch';
  import { isRunning } from './work-blocks';
  import CodeDiffCard from './CodeDiffCard.svelte';
  import ClampedBlock from './ClampedBlock.svelte';

  let { step, chatId }: { step: AgentStep; chatId?: string } = $props();

  const OUTPUT_LIMIT = 32_768;
  const KIND_ICON = { read: FileText, list: FolderOpen, search: Search, edit: FilePen, command: SquareTerminal, web: Globe, subagent: Bot, other: Wrench };

  const kind = $derived(stepKind(step));
  const running = $derived(isRunning(step));
  const isApproval = $derived(step.status === 'awaiting_approval' || approvalsStore.items.some((a) => a.id === step.id));
  const isError = $derived(step.status === 'error');
  const isCommand = $derived(kind === 'command');
  const plan = $derived(step.toolName === 'present_plan' ? parsePlan(step.output) : null);
  const target = $derived(isApproval ? '' : (step.detail ?? '').split('\n')[0]);
  const adds = $derived(step.diffStats?.reduce((sum, file) => sum + file.additions, 0) || 0);
  const dels = $derived(step.diffStats?.reduce((sum, file) => sum + file.deletions, 0) || 0);
  const patches = $derived((step.diffStats ?? []).filter((file) => file.patch));
  const output = $derived(isApproval ? step.detail || step.output || '' : step.output || '');
  /** What the tool was asked, when the chip's one line doesn't say it all. */
  const input = $derived.by(() => {
    const detail = step.detail ?? '';
    return !isCommand && !isApproval && (detail.length > 60 || detail.includes('\n')) ? detail : '';
  });
  /** `cmd | tail` prints nothing until the command ends: say so instead of looking stuck. */
  const tailPipe = $derived(/\|\s*tail\b/.test(step.detail || ''));
  const expandable = $derived(!plan && (running || isApproval || !!output || !!input || patches.length > 0));

  let userToggled = $state(false);
  let open = $state(false);
  $effect(() => {
    // Approvals and failures need eyes at once; the rest opens on demand.
    if (!userToggled) open = isApproval || isError;
  });

  // Live elapsed time while running.
  let startedAt: number | null = null;
  let elapsed = $state<number | undefined>(undefined);
  $effect(() => {
    if (!running) return;
    startedAt ??= Date.now();
    const timer = setInterval(() => (elapsed = Date.now() - (startedAt ?? Date.now())), 250);
    return () => clearInterval(timer);
  });

  const Icon = $derived(running ? Loader2 : isApproval ? AlertCircle : isError ? XCircle : plan ? ListChecks : KIND_ICON[kind]);

  function toggle() {
    if (plan) {
      if (chatId) codeWorkspace.showPlan(chatId, plan);
      return;
    }
    if (!expandable) return;
    userToggled = true;
    open = !open;
  }

  function stopCommand() {
    if (chatId) void codeStore.stop(chatId).catch((error) => toastStore.error(String(error)));
  }

  /** The file an approval's diff is about, from its `+++` header. */
  function patchPath(text: string): string {
    return /^\+\+\+ (.+)$/m.exec(text)?.[1]?.trim() || step.label;
  }
</script>

<!-- A settled approval says nothing the tool's own row doesn't: hide it. -->
{#if !(step.type === 'approval' && !isApproval)}
<div class="step" class:is-error={isError} class:is-approval={isApproval}>
  <div class="flex min-w-0 items-center">
    <button type="button" class="step-head" onclick={toggle} aria-expanded={expandable ? open : undefined} disabled={!expandable && !plan}>
      <Icon class="step-icon size-3.5 shrink-0 {running ? 'animate-spin' : ''}" />
      <span class="verb shrink-0">{step.label}</span>
      {#if target}<code class="chip min-w-0 truncate">{target}</code>{/if}
      {#if adds || dels}
        <span class="shrink-0 text-xs tabular-nums">
          {#if adds}<span class="text-success">+{adds}</span>{/if}
          {#if dels}<span class="ml-1 text-error">−{dels}</span>{/if}
        </span>
      {/if}
      <span class="flex-1"></span>
      {#if running && elapsed !== undefined}<span class="shrink-0 text-xs tabular-nums text-muted-foreground">{formatToolDuration(elapsed)}</span>{/if}
      {#if plan}<span class="shrink-0 text-xs text-muted-foreground">{$t('code.plan.open')}</span>{/if}
      {#if expandable}<ChevronRight class="chevron size-3.5 shrink-0 {open ? 'rotate-90' : ''}" />{/if}
    </button>
    {#if running && isCommand && chatId}
      <button type="button" class="stop" aria-label={$t('code.stopCommand')} title={$t('code.stopCommand')} onclick={stopCommand}><Square class="size-3" /></button>
    {/if}
  </div>

  {#if open}
    <div class="step-body">
      {#if isCommand}
        <div class="term">
          <div class="term-head"><span class="text-muted-foreground">$</span> {step.detail}</div>
          {#if output}
            <ClampedBlock tail={running}><pre class="term-out">{output.slice(-OUTPUT_LIMIT)}{#if running}<span class="caret"></span>{/if}</pre></ClampedBlock>
          {:else if running}
            <p class="term-note">{tailPipe ? 'This pipe prints its tail when the command finishes.' : $t('codeWs.noOutput')}</p>
          {/if}
        </div>
      {:else if isApproval && looksLikePatch(output)}
        <CodeDiffCard path={patchPath(output)} patch={output} />
      {:else if patches.length}
        {#each patches as file (file.path)}
          <CodeDiffCard path={file.path} patch={file.patch ?? ''} additions={file.additions} deletions={file.deletions} onopen={() => codeWorkspace.showFileInChanges(file.path)} />
        {/each}
      {:else}
        {#if input}
          <p class="section-label">{$t('code.toolInput')}</p>
          <div class="out"><ClampedBlock><pre>{input}</pre></ClampedBlock></div>
        {/if}
        {#if output}
          {#if input}<p class="section-label">{$t('code.toolResult')}</p>{/if}
          <div class="out" class:text-error={isError}><ClampedBlock><pre>{output.slice(-OUTPUT_LIMIT)}</pre></ClampedBlock></div>
        {:else if running}
          <p class="term-note">{$t('codeWs.noOutput')}</p>
        {/if}
        {#if kind === 'edit' && step.status === 'done' && step.fileChanges?.length}
          <button type="button" class="view-link self-start" onclick={() => codeWorkspace.showFileInChanges(step.fileChanges?.[0]?.path ?? '')}>{$t('codeWs.viewChanges')}</button>
        {/if}
      {/if}
      {#if isApproval}
        <div class="flex items-center gap-2 pt-1">
          <button type="button" class="approve-btn" onclick={() => approvalsStore.resolve(step.id, false)}>{copy.tool.deny}</button>
          <button type="button" class="approve-btn primary" onclick={() => approvalsStore.resolve(step.id, true)}>{copy.tool.allow}</button>
        </div>
      {/if}
    </div>
  {/if}
</div>
{/if}

<style>
  .step-head {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 0.5rem;
    font-size: 13px;
    color: var(--muted-foreground);
    text-align: left;
    transition: color var(--motion-fast) var(--motion-ease);
  }
  /* No hover fill: the text brightens and the chevron shows that it opens. */
  .step-head:not(:disabled):hover,
  .step-head:focus-visible {
    color: var(--foreground);
  }
  .step-head:not(:disabled):hover .chip {
    color: var(--foreground);
  }
  .step-head:disabled {
    cursor: default;
  }
  .verb {
    color: var(--foreground);
  }
  .chip {
    padding: 0.0625rem 0.375rem;
    border-radius: 0.3125rem;
    background: var(--muted);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .step-head :global(.chevron) {
    opacity: 0;
    transition: transform var(--motion-fast) var(--motion-ease), opacity var(--motion-fast) var(--motion-ease);
  }
  .step-head:hover :global(.chevron),
  .step-head:focus-visible :global(.chevron),
  .step-head[aria-expanded='true'] :global(.chevron) {
    opacity: 1;
  }
  .step.is-error :global(.step-icon) {
    color: var(--error);
  }
  .step.is-approval :global(.step-icon) {
    color: var(--warning);
  }
  .stop {
    display: inline-flex;
    padding: 0.25rem 0.5rem;
    color: var(--muted-foreground);
  }
  .stop:hover {
    color: var(--foreground);
  }
  /* Details sit under the verb (past the icon). */
  .step-body {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem 0.625rem 1.875rem;
  }
  .step.is-approval .step-body {
    padding: 0.5rem 0.625rem 0.625rem;
    margin: 0.25rem 0 0.25rem 1.375rem;
    border-radius: 0.625rem;
    border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border));
    background: color-mix(in srgb, var(--warning) 5%, transparent);
  }
  .section-label {
    font-size: 12px;
    color: var(--muted-foreground);
  }
  pre {
    margin: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    line-height: 1.55;
  }
  /* Output wraps and grows (cut past a height by ClampedBlock): no scroll boxes. */
  .out {
    border-radius: 0.5rem;
    background: var(--muted);
    color: var(--foreground);
  }
  .out pre {
    padding: 0.5rem 0.625rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .out.text-error pre {
    color: var(--error);
  }
  /* assistant-ui's terminal block: the command on top, output below. */
  .term {
    overflow: hidden;
    border-radius: 0.625rem;
    border: 1px solid var(--border-subtle);
    background: var(--background);
  }
  .term-head {
    padding: 0.375rem 0.625rem;
    border-bottom: 1px solid var(--border-subtle);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    color: var(--foreground);
  }
  .term-out {
    padding: 0.5rem 0.625rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--foreground);
  }
  .term-note {
    padding: 0.375rem 0.625rem;
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .view-link {
    font-size: 12px;
    color: var(--muted-foreground);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .view-link:hover {
    color: var(--foreground);
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
