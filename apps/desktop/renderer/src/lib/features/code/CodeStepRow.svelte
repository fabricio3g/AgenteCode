<svelte:options runes={true} />

<!--
  One tool call in a work block: an
  icon for the kind of work, the verb, and what it touched as a mono chip —
  "Run  npm test", "Edit  src/app.ts  +14 −3". It opens to what it did:
  commands as a terminal block (the command, its streaming output), edits as
  a diff card per file, approvals as the diff with Allow / Deny, other tools
  as their input and result. A presented plan opens in the right dock.

  A `task` call is not a tool call: it is the spawn of an agent, so it draws as
  the subagent it started (see SubagentCard) instead of as a row whose subject
  was the arguments it was given.
-->

<script lang="ts">
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { AlertCircle, Copy, FilePen, FileText, FolderOpen, Globe, ListChecks, Search, Square, SquareTerminal, Wrench, XCircle } from 'lucide-svelte';
  import type { AgentStep } from '$lib/types/chat';
  import type { CodeChild } from '$shared/agente-protocol';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { formatToolDuration, toolTarget } from '$lib/utils/tool-ui';
  import { shortModel } from '$lib/utils/format';
  import { copy } from '$lib/copy';
  import { ActiveDuration } from '$lib/utils/active-duration';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { codeWorkspace } from './workspace.svelte';
  import { codeStore } from './code.svelte';
  import { stepKind } from './activity';
  import { parsePlan } from './plan-review';
  import { looksLikePatch } from './patch';
  import { isRunning } from './work-blocks';
  import { childFromStep } from './subagent-row';
  import CodeDiffCard from './CodeDiffCard.svelte';
  import ClampedBlock from './ClampedBlock.svelte';
  import Disclosure from './Disclosure.svelte';
  import SubagentCard from './SubagentCard.svelte';

  let {
    step,
    id,
    chatId,
    children
  }: {
    step: AgentStep;
    /** Disclosure store key; `disclosureKey(chatId, messageId, entryKey)`. */
    id: string;
    chatId?: string;
    /** The run's children, so a spawn finds the one it started. */
    children?: CodeChild[];
  } = $props();

  const OUTPUT_LIMIT = 32_768;
  const KIND_ICON = { read: FileText, list: FolderOpen, search: Search, edit: FilePen, command: SquareTerminal, web: Globe, subagent: Wrench, other: Wrench };

  /** A spawn: the row belongs to the agent it started. */
  const isSpawn = $derived(step.toolName === 'task');
  const child = $derived(children?.find((candidate) => candidate.id === step.subagentId));
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
  const plan = $derived(step.toolName === 'present_plan' ? parsePlan(step.output) : null);
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
    if (chatId) void codeStore.stop(chatId).catch((error) => toastStore.error(String(error)));
  }

  async function copyValue(value: string) {
    if (await writeToClipboard(value)) toastStore.success($t('chat.copied'));
  }

  /** The file an approval's diff is about, from its `+++` header. */
  function patchPath(text: string): string {
    return /^\+\+\+ (.+)$/m.exec(text)?.[1]?.trim() || step.label;
  }
</script>

{#if isSpawn}
  <SubagentCard child={child ?? childFromStep(step)} {id} {chatId} pending={!child && running} />
{:else if !(step.type === 'approval' && !isApproval)}
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
      {#if running}<TileMeter mode="busy" />{:else}<Icon class="step-icon size-3.5 shrink-0 {isError ? 'is-error' : ''} {isApproval ? 'is-approval' : ''}" />{/if}
      <span class="verb shrink-0" class:ui-shimmer-text={running}>{step.label}</span>
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
            <CodeDiffCard path={file.path} patch={file.patch ?? ''} additions={file.additions} deletions={file.deletions} onopen={() => codeWorkspace.showFileInChanges(file.path)} />
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
          {#if kind === 'edit' && step.status === 'done' && step.fileChanges?.length}
            <UiButton variant="plain" type="button" class={uiClass("view-link self-start", "ui-local-af21c610")} onclick={() => codeWorkspace.showFileInChanges(step.fileChanges?.[0]?.path ?? '')}>{$t('codeWs.viewChanges')}</UiButton>
          {/if}
        {/if}
        {#if isApproval}
          <div class="flex items-center gap-2 pt-1">
            <UiButton variant="plain" type="button" class={uiClass("approve-btn", "ui-local-af21c610")} onclick={() => approvalsStore.resolve(pending?.id ?? step.id, false)}>{copy.tool.deny}</UiButton>
            <UiButton variant="plain" type="button" class={uiClass("approve-btn primary", "ui-local-af21c610")} onclick={() => approvalsStore.resolve(pending?.id ?? step.id, true)}>{copy.tool.allow}</UiButton>
          </div>
        {/if}
      </div>
    {/snippet}
  </Disclosure>
{/if}

<style>
  .verb {
    color: var(--foreground);
  }
  .chip {
    padding: 0.0625rem 0.375rem;
    border-radius: 0.3125rem;
    background: var(--muted);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  /* Which model did the work: provenance, dimmer than the subject. */
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
  /* An approval is the one row that asks for an answer: a tinted band on a warning rail,
     not a bordered box — the terminal and diff cards inside it bring their own edges. */
  .step-inner.is-approval {
    padding: 0.5rem 0.625rem 0.625rem;
    border-radius: 0 0.5rem 0.5rem 0;
    border-left: 2px solid color-mix(in srgb, var(--warning) 60%, transparent);
    background: color-mix(in srgb, var(--warning) 5%, transparent);
  }
  .trace-label {
    display:flex; align-items:center; justify-content:space-between; gap:0.5rem;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  pre {
    margin: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-xs);
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
  /* Terminal block: the command on top, output below. */
  .term {
    overflow: hidden;
    border-radius: 0.625rem;
    border: 1px solid var(--border-subtle);
    background: var(--background);
  }
  .term-head {
    display:flex; align-items:center; justify-content:space-between; gap:0.5rem;
    padding: 0.375rem 0.625rem;
    border-bottom: 1px solid var(--border-subtle);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-xs);
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
  :global(.approve-btn.ui-local-af21c610) {
    height: 1.75rem;
    padding: 0 0.75rem;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--foreground);
    border: 1px solid var(--border);
    background: var(--background);
  }
  :global(.approve-btn:hover.ui-local-af21c610) {
    background: var(--surface-hover);
  }
  :global(.approve-btn.primary.ui-local-af21c610) {
    border-color: var(--primary);
    background: var(--primary);
    color: var(--primary-fg);
  }
  :global(.approve-btn.primary:hover.ui-local-af21c610) {
    opacity: 0.9;
  }
  @media (prefers-reduced-motion: reduce) {
    .caret { animation: none; }
    :global(.step-icon.is-running) { animation: none; }
  }
</style>
