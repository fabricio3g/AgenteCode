<svelte:options runes={true} />

<!--
  One non-spawn tool call in a work block (and inside a subagent's tool list):
  an icon for the kind of work, the verb, and what it touched as a mono chip —
  "Run  npm test", "Edit  src/app.ts  +14 −3". It opens to what it did:
  commands as a terminal block (the command, its streaming output), edits as
  a diff card per file, approvals as the diff with Allow / Deny, other tools
  as their input and result. A presented plan opens in the right dock.

  Leaf component: never imports SubagentCard so subagent views can render
  child tool steps without forming a circular dependency.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { AlertCircle, Copy, FilePen, FileText, FolderOpen, Globe, ListChecks, Search, Square, SquareTerminal, Wrench, XCircle } from '$lib/icons';
  import type { AgentStep } from '$lib/types/chat';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { formatToolDuration, toolTarget } from '$lib/utils/tool-ui';
  import { shortModel } from '$lib/utils/format';
  import { ActiveDuration } from '$lib/utils/active-duration';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { codeWorkspace } from './workspace.svelte';
  import { codeStore } from './code.svelte';
  import { stepKind } from './activity';
  import { parsePlan } from './plan-review';
  import { looksLikePatch } from './patch';
  import { isRunning } from './work-blocks';
  import CodeDiffCard from './CodeDiffCard.svelte';
  import ClampedBlock from './ClampedBlock.svelte';
  import Disclosure from './Disclosure.svelte';

  let {
    step,
    id,
    chatId,
    codeActions = true,
    onstop
  }: {
    step: AgentStep;
    /** Disclosure store key; `disclosureKey(chatId, messageId, entryKey)`. */
    id: string;
    chatId?: string;
    codeActions?: boolean;
    onstop?: () => void;
  } = $props();

  const OUTPUT_LIMIT = 32_768;
  const KIND_ICON = { read: FileText, list: FolderOpen, search: Search, edit: FilePen, command: SquareTerminal, web: Globe, subagent: Wrench, other: Wrench };

  const kind = $derived(stepKind(step));
  const running = $derived(isRunning(step));
  /**
   * An approval row lives exactly as long as its request is pending.
   *
   * The step's own status is not the source of truth: nothing ever revises an
   * `awaiting_approval` step — the engine reports no resolution — so keying on
   * it left dead Allow/Deny buttons on screen after the user had answered, and
   * after a switch to full mode that answered every pending request at once.
   */
  const pending = $derived(approvalsStore.forRequest(step.id));
  const isApproval = $derived(!!pending);
  const isError = $derived(step.status === 'error');
  const isCommand = $derived(kind === 'command');
  const plan = $derived(codeActions && step.toolName === 'present_plan' ? parsePlan(step.output) : null);
  const target = $derived(isApproval ? '' : toolTarget(step.toolName, step.detail));
  const adds = $derived(step.diffStats?.reduce((sum, file) => sum + file.additions, 0) || 0);
  const dels = $derived(step.diffStats?.reduce((sum, file) => sum + file.deletions, 0) || 0);
  const patches = $derived((step.diffStats ?? []).filter((file) => file.patch));
  const output = $derived(isApproval ? step.detail || step.output || '' : step.output || '');
  /** What the tool was asked, when the chip's one line doesn't say it all. */
  const input = $derived.by(() => {
    const detail = step.detail ?? '';
    return !isCommand && !isApproval ? (step.toolInput || ((detail.length > 60 || detail.includes('\n') || /^(task_output|kill_task)$/.test(step.toolName ?? '')) ? detail : '')) : '';
  });
  /** `cmd | tail` prints nothing until the command ends: say so instead of looking stuck. */
  const tailPipe = $derived(/\|\s*tail\b/.test(step.detail || ''));
  const expandable = $derived(!plan && (running || isApproval || !!output || !!input || patches.length > 0));

  // Monotonic active intervals survive stop/resume without counting the pause.
  const clock = new ActiveDuration();
  let elapsed = $state<number | undefined>(undefined);
  $effect(() => {
    if (!running) return;
    clock.resume();
    elapsed = clock.elapsed();
    const timer = setInterval(() => (elapsed = clock.elapsed()), 250);
    return () => { clearInterval(timer); clock.pause(); };
  });
  /** Live while it runs, frozen once it ends, so a settled row still says how long it took. */
  const duration = $derived(running ? elapsed : step.durationMs);

  const Icon = $derived(isApproval ? AlertCircle : isError ? XCircle : plan ? ListChecks : KIND_ICON[kind]);

  function openPlan() {
    if (chatId && plan) codeWorkspace.showPlan(chatId, plan);
  }

  function stopRun() {
    if (onstop) onstop();
    else if (chatId) void codeStore.stop(chatId).catch((error) => toastStore.error(String(error)));
  }

  async function copyValue(value: string) {
    if (await writeToClipboard(value)) toastStore.success($t('chat.copied'));
  }

  /** The file an approval's diff is about, from its `+++` header. */
  function patchPath(text: string): string {
    return /^\+\+\+ (.+)$/m.exec(text)?.[1]?.trim() || step.label;
  }
</script>

{#if !(step.type === 'approval' && !isApproval)}
  <!-- A settled approval says nothing the tool's own row doesn't: hide it. -->
  <Disclosure
    {id}
    level="step"
    chevron="trailing"
    disabled={!expandable}
    defaultOpen={isApproval}
    onActivate={plan ? openPlan : undefined}
  >
    {#snippet header()}
      <Icon class="step-icon size-3.5 shrink-0 {isError ? 'is-error' : ''} {isApproval ? 'is-approval' : ''} {running ? 'is-running' : ''}" />
      <span class="verb shrink-0" class:is-running={running} class:ui-shimmer-text={running}>{step.label}</span>
      {#if target}<code class="chip min-w-0 truncate">{target}</code>{/if}
      {#if step.model}<code class="chip model-chip shrink-0" title={step.model}>{shortModel(step.model)}</code>{/if}
      {#if adds || dels}
        <span class="shrink-0 text-xs tabular-nums">
          {#if adds}<span class="text-success">+{adds}</span>{/if}
          {#if dels}<span class="ml-1 text-error">−{dels}</span>{/if}
        </span>
      {/if}
      <span class="flex-1"></span>
      {#if duration !== undefined}<span class="duration shrink-0 tabular-nums">{formatToolDuration(duration)}</span>{/if}
      {#if plan}<span class="duration shrink-0">{$t('code.plan.open')}</span>{/if}
    {/snippet}

    {#snippet actions()}
      {#if running && isCommand && chatId}
        <IconButton label={$t('code.stopRun')} size="xs" variant="ghost" type="button" class={uiClass("stop", "ui-local-af21c610")}  title={$t('code.stopRun')} onclick={stopRun}><Square class="size-3" /></IconButton>
      {/if}
    {/snippet}

    {#snippet body()}
      <div class="step-inner" class:is-approval={isApproval}>
        {#if isCommand}
          <div class="term">
            <div class="term-head"><span class="term-command"><span class="text-muted-foreground">$</span> {step.detail}</span>{#if step.detail}<IconButton label={$t('code.traceCopyCommand')} size="xs" onclick={() => void copyValue(step.detail ?? '')}><Copy /></IconButton>{/if}</div>
            {#if output}
              <div class="trace-label"><span>{$t('code.toolResult')}</span><IconButton label={$t('code.traceCopyOutput')} size="xs" onclick={() => void copyValue(output)}><Copy /></IconButton></div>
              <ClampedBlock tail={running}><pre class="term-out">{running ? output.slice(-OUTPUT_LIMIT) : output}{#if running}<span class="caret"></span>{/if}</pre></ClampedBlock>
            {:else if running}
              <p class="term-note">{tailPipe ? 'This pipe prints its tail when the command finishes.' : $t('codeWs.noOutput')}</p>
            {/if}
          </div>
        {:else if isApproval && looksLikePatch(output)}
          <CodeDiffCard path={patchPath(output)} patch={output} />
        {:else if patches.length}
          {#each patches as file (file.path)}
            <CodeDiffCard path={file.path} patch={file.patch ?? ''} additions={file.additions} deletions={file.deletions} onopen={codeActions ? () => codeWorkspace.showFileInChanges(file.path) : undefined} />
          {/each}
        {:else}
          {#if input}
            <div class="trace-label"><span>{$t('code.toolInput')}</span><IconButton label={$t('code.traceCopyInput')} size="xs" onclick={() => void copyValue(input)}><Copy /></IconButton></div>
            <div class="out"><ClampedBlock><pre>{input}</pre></ClampedBlock></div>
          {/if}
          {#if output}
            <div class="trace-label"><span>{$t('code.toolResult')}</span><IconButton label={$t('code.traceCopyOutput')} size="xs" onclick={() => void copyValue(output)}><Copy /></IconButton></div>
            <div class="out" class:text-error={isError}><ClampedBlock><pre>{running ? output.slice(-OUTPUT_LIMIT) : output}</pre></ClampedBlock></div>
          {:else if running}
            <p class="term-note">{$t('codeWs.noOutput')}</p>
          {/if}
          {#if codeActions && kind === 'edit' && step.status === 'done' && step.fileChanges?.length}
            <UiButton variant="plain" type="button" class={uiClass("view-link self-start", "ui-local-af21c610")} onclick={() => codeWorkspace.showFileInChanges(step.fileChanges?.[0]?.path ?? '')}>{$t('codeWs.viewChanges')}</UiButton>
          {/if}
        {/if}
        {#if isApproval}
          <!-- Every composer carries the approval bar: one pair of buttons, there. -->
          <p class="approval-note">{$t('code.approve.below')}</p>
        {/if}
      </div>
    {/snippet}
  </Disclosure>
{/if}

<style>
  .verb {
    color: var(--text-secondary);
  }
  .verb.is-running,
  :global(.head:not(:disabled):hover) .verb {
    color: var(--foreground);
  }
  :global(.step-icon.is-running) {
    color: var(--brand-accent);
  }
  .chip {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .model-chip {
    opacity: 0.75;
  }
  .duration {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  :global(.step-icon.is-error) {
    color: var(--error);
  }
  :global(.step-icon.is-approval) {
    color: var(--warning);
  }
  :global(.stop.ui-local-af21c610) {
    display: inline-flex;
    padding: 0.25rem 0.5rem;
    color: var(--muted-foreground);
  }
  :global(.stop:hover.ui-local-af21c610) {
    color: var(--foreground);
  }
  .step-inner {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .step-inner.is-approval {
    padding: 0.625rem 0.75rem;
    border-radius: var(--float-radius);
    border: 1px solid var(--float-border);
    background: color-mix(in srgb, var(--foreground) 3%, transparent);
  }
  .approval-note {
    margin: 0;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .trace-label {
    display:flex; align-items:center; justify-content:space-between; gap:0.5rem;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  pre {
    margin: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-code);
    line-height: 1.55;
  }
  .out {
    border-radius: 0.5rem;
    border: 1px solid var(--border-subtle);
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
  .term {
    overflow: hidden;
    border-radius: 0.625rem;
    border: 1px solid var(--border);
    background: var(--card);
  }
  .term-head {
    display:flex; align-items:center; justify-content:space-between; gap:0.5rem;
    padding: 0.375rem 0.625rem;
    border-bottom: 1px solid var(--border);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-code);
    color: var(--foreground);
  }
  .term-command { min-width:0; overflow-wrap:anywhere; }
  .term .trace-label { padding:0.125rem 0.625rem 0; }
  .term-out {
    padding: 0.5rem 0.625rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--foreground);
  }
  .term-note {
    padding: 0.375rem 0.625rem;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  :global(.view-link.ui-local-af21c610) {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  :global(.view-link:hover.ui-local-af21c610) {
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
  @media (prefers-reduced-motion: reduce) {
    .caret { animation: none; }
    :global(.step-icon.is-running) { animation: none; }
  }
</style>
