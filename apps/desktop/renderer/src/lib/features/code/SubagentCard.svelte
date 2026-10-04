<svelte:options runes={true} />

<!--
  One subagent, wherever it appears: on the `task` step that asked for it, and
  in the group that holds the spawns no step points at.

  A subagent is an agent, not a tool call, so its row is the loudest one inside
  a work block: the kind is named in full ("Explore", not "Task"), the
  description follows, and the right side says what it is doing, how much it has
  done and what it cost. Everything it did sits one level down, behind the
  shared disclosure.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Bot, Copy, ListChecks, Square, Telescope } from 'lucide-svelte';
  import type { CodeChild } from '$shared/agente-protocol';
  import { invoke } from '$lib/services/bridge';
  import { copy } from '$lib/copy';
  import { toastStore } from '$lib/stores/toast.svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { formatToolDuration, titleCaseToolName } from '$lib/utils/tool-ui';
  import { shortModel } from '$lib/utils/format';
  import ClampedBlock from './ClampedBlock.svelte';
  import CodeStepRow from './CodeStepRow.svelte';
  import CodeErrorNotice from './CodeErrorNotice.svelte';
  import Disclosure from './Disclosure.svelte';
  import { childActivity, childElapsedMs } from './subagent-row';
  import { spendCostLabel, spendLabel } from './accounting';

  let {
    child,
    id,
    pending = false
  }: {
    child: CodeChild;
    /** Disclosure store key; `disclosureKey(chatId, messageId, entryKey)`. */
    id: string;
    /** The `task` step's row before its child has registered. */
    pending?: boolean;
  } = $props();

  const failed = $derived(child.status === 'error');
  const running = $derived(pending || child.status === 'running');

  /** What the row says it is doing: its current tool, or where it got to. */
  const status = $derived(
    failed
      ? copy.tool.failed
      : child.status === 'done'
        ? copy.tool.done
        : pending
          ? $t('code.subagent.starting')
          : (childActivity(child) ?? copy.status.working)
  );

  // Wall-clock stamps rather than a stopwatch: the same numbers a saved turn
  // carries, so a reopened conversation shows the duration it really took.
  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(timer);
  });
  const elapsed = $derived(childElapsedMs(child, now));

  const kindLabel = $derived(titleCaseToolName(child.kind || 'subagent'));
  const Icon = $derived(/explore/i.test(child.kind) ? Telescope : /plan/i.test(child.kind) ? ListChecks : Bot);  const toolCount = $derived(child.tools.length);
  const cost = $derived(spendCostLabel(child.spend));

  const answer = $derived(child.summary || child.text);
  const errorDetail = $derived(failed ? child.summary || child.text : '');
  const reply = $derived(failed && child.text.trim() === errorDetail.trim() ? '' : child.text);
  /** The cache rate is the one thing the row's own line cannot carry. */
  const spendDetail = $derived(spendLabel(child.spend).includes('cached') ? spendLabel(child.spend) : '');

  /*
   * While the child is running its text arrives a delta at a time. Marking it
   * streaming keeps the renderer on its cheap path — the settled prefix is
   * written once and only the tail re-renders — instead of re-parsing the whole
   * answer, syntax highlighting included, on every delta.
   */
  const streamStatus = $derived(failed ? 'error' : running ? 'streaming' : 'idle');

  async function stop() {
    try { await invoke('agente_child_cancel', { runId: child.id }); }
    catch (error) { toastStore.error(String(error)); }
  }

  async function copyText() {
    try {
      if (!await writeToClipboard(answer)) throw new Error('Could not copy the subagent text');
      toastStore.success($t('chat.copied'));
    } catch (error) { toastStore.error(String(error)); }
  }
</script>

<!--
  Folded by default, like every other row: what a running child is doing is
  already on the line (its current tool, its tool count, its elapsed time), and
  an answer streaming into the row would push the rest of the transcript off
  the screen. A failure opens, because that is the one thing the line cannot
  say.
-->
<Disclosure {id} level="subagent" chevron="leading" defaultOpen={failed}>
  {#snippet header()}
    <!--
      Two lines: who this is, then what it is doing. One line could not hold a
      kind, a description, a model and a cost without eating the description —
      the only part that says what the child was asked to do.
    -->
    <span class="stack min-w-0">
      <span class="identity min-w-0">
        <Icon class="kind-icon size-3.5 shrink-0" />
        <span class="kind shrink-0">{kindLabel}</span>
        {#if child.description}<span class="description min-w-0 truncate">· {child.description}</span>{/if}
      </span>
      <span class="meta min-w-0" class:text-error={failed}>
        <span class="dot" class:is-live={running} aria-hidden="true"></span>
        <span class="state" class:ui-shimmer-text={running}>{status}</span>
        {#if toolCount}<span class="tabular-nums">· {$t('code.subagent.tools', { values: { n: toolCount } })}</span>{/if}
        {#if child.model}<span class="model min-w-0 truncate" title={child.model}>{shortModel(child.model)}</span>{/if}
        {#if cost}<span class="tabular-nums">· {cost}</span>{/if}
      </span>
    </span>
    <span class="flex-1"></span>
    {#if elapsed !== undefined}<span class="elapsed shrink-0 tabular-nums">{formatToolDuration(elapsed)}</span>{/if}
  {/snippet}

  {#snippet body()}
    {#if running && !pending}
      <button type="button" class="card-action stop-action" onclick={stop}><Square class="size-3" />{$t('code.stopSubagent')}</button>
    {/if}
    {#if failed && errorDetail}<CodeErrorNotice detail={errorDetail} />{/if}
    {#if reply}
      <div>
        <ClampedBlock max="22rem" tail={running}>
          <RichContent content={reply} status={streamStatus} />
        </ClampedBlock>
        {#if !running}
          <button type="button" class="card-action" onclick={copyText}><Copy class="size-3" />{copy.actions.copy}</button>
        {/if}
      </div>
    {/if}
    {#each child.tools as tool (tool.id)}
      <CodeStepRow step={{ id: tool.id, type: 'tool', label: tool.name, toolName: tool.name, status: tool.status, output: tool.output }} id={`${id}:t:${tool.id}`} />
    {/each}
    {#if !failed && child.summary && !child.text.trimEnd().endsWith(child.summary.trim())}<RichContent content={child.summary} />{/if}
    {#if spendDetail}<p class="spend">{spendDetail}</p>{/if}
  {/snippet}
</Disclosure>

<style>
  .kind {
    color: var(--foreground);
    font-weight: 500;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }
  .identity {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .description {
    color: var(--muted-foreground);
  }
  .elapsed {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  /* The meta line is a fact sheet, not a sentence: same size, dimmer, and the
     model keeps its own face so it never reads as part of the status. */
  .meta {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    overflow: hidden;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  /* The status is the one part that gives way: the dot and the numbers beside
     it already say most of it, and a clipped cost says nothing at all. */
  .meta > span {
    flex-shrink: 0;
  }
  .state {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .meta.text-error {
    color: var(--error);
  }
  .dot {
    width: 0.3rem;
    height: 0.3rem;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.45;
  }
  /* A live child breathes; a settled one is a plain mark. */
  .dot.is-live {
    background: var(--brand-accent, var(--primary));
    opacity: 0.9;
    animation: subagent-breathe 1.4s ease-in-out infinite;
  }
  @keyframes subagent-breathe {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }
  .card-action {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-md);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    transition: color var(--motion-fast) var(--motion-ease);
  }
  .card-action:hover,
  .card-action:focus-visible {
    color: var(--foreground);
  }
  /* Stop is an action, not a row: give it a button's edges so it does not read
     as one more line of the child's work. */
  .stop-action {
    align-self: flex-start;
    border: 1px solid var(--border);
    padding: 0.1875rem 0.5rem;
  }
  .stop-action:hover,
  .stop-action:focus-visible {
    background: var(--surface-hover);
  }
  .spend {
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--muted-foreground);
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.is-live { animation: none; opacity: 0.9; }
  }
</style>
