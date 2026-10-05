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
  import { codeStore } from './code.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { formatToolDuration, titleCaseToolName } from '$lib/utils/tool-ui';
  import { shortModel } from '$lib/utils/format';
  import ClampedBlock from './ClampedBlock.svelte';
  import CodeStepRow from './CodeStepRow.svelte';
  import CodeErrorNotice from './CodeErrorNotice.svelte';
  import Disclosure from './Disclosure.svelte';
  import TileMeter from './TileMeter.svelte';
  import { childActivity, childElapsedMs } from './subagent-row';
  import { spendCostLabel, spendLabel } from './accounting';

  let {
    child,
    id,
    chatId,
    pending = false
  }: {
    child: CodeChild;
    /** Disclosure store key; `disclosureKey(chatId, messageId, entryKey)`. */
    id: string;
    /** The conversation, so a stopped turn stops this child's meter too. */
    chatId?: string;
    /** The `task` step's row before its child has registered. */
    pending?: boolean;
  } = $props();

  const failed = $derived(child.status === 'error');
  const running = $derived(pending || child.status === 'running');

  /**
   * Stop was pressed here, or on the turn this child belongs to. Either way the
   * meter freezes at once: the engine needs a moment to unwind, and a child that
   * has been told to stop should not go on raining while it does.
   */
  let stopped = $state(false);
  const stopping = $derived(stopped || (chatId ? !!codeStore.runFor(chatId)?.stopping : false));
  const meter: 'busy' | 'quiet' | 'stopped' = $derived(stopping ? 'stopped' : running ? 'busy' : 'quiet');

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
    stopped = true;
    try { await invoke('agente_child_cancel', { runId: child.id }); }
    catch (error) { stopped = false; toastStore.error(String(error)); }
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
  already on the card (its current tool, its tool count, its elapsed time), and
  an answer streaming into it would push the rest of the transcript off the
  screen. A failure stays folded too; its status remains on the card.

  Three rows, because a child is an agent and not a call: who it is and what it
  cost, what it is doing right now, then the counts that say how far in it is.
  Stop sits on the first row, so a runaway child dies without opening it first.
-->
<Disclosure {id} level="subagent" variant="card" chevron="leading" defaultOpen={false}>
  {#snippet header()}
    <span class="card min-w-0">
      <span class="identity min-w-0">
        <Icon class="kind-icon size-3.5 shrink-0" />
        <span class="kind shrink-0">{kindLabel}</span>
        {#if child.description}<span class="description min-w-0 truncate">· {child.description}</span>{/if}
        {#if cost}<span class="cost shrink-0 tabular-nums">{cost}</span>{/if}
      </span>
      <span class="live min-w-0" class:text-error={failed}>
        {#if running}<TileMeter mode={meter} />{:else}<span class="dot" aria-hidden="true"></span>{/if}
        <span class="state min-w-0" class:ui-shimmer-text={running}>{status}</span>
        {#if elapsed !== undefined}<span class="elapsed shrink-0 tabular-nums">{formatToolDuration(elapsed)}</span>{/if}
      </span>
      {#if toolCount || child.model || spendDetail}
        <span class="foot min-w-0">
          {#if toolCount}<span class="tabular-nums">{$t('code.subagent.tools', { values: { n: toolCount } })}</span>{/if}
          {#if child.model}<span class="model min-w-0 truncate" title={child.model}>{shortModel(child.model)}</span>{/if}
          {#if spendDetail}<span class="tabular-nums">{spendDetail}</span>{/if}
        </span>
      {/if}
    </span>
  {/snippet}

  {#snippet actions()}
    {#if running && !pending && !stopping}
      <button
        type="button"
        class="card-action stop-action"
        title={$t('code.stopSubagent')}
        aria-label={$t('code.stopSubagent')}
        onclick={stop}
      ><Square class="size-3" /></button>
    {/if}
  {/snippet}

  {#snippet body()}
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
  {/snippet}
</Disclosure>

<style>
  .kind {
    color: var(--foreground);
    font-weight: 500;
  }
  /* The card's own column: identity, the live line, then the counts. */
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    width: 100%;
  }
  .identity {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .description {
    color: var(--muted-foreground);
  }
  /* Cost is a fact about the whole child, so it ends the line that names it
     instead of hiding in the body. */
  .cost {
    margin-left: auto;
    padding-left: 0.5rem;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  /* The live line is a fact sheet, not a sentence: smallest type, dimmest, and
     the elapsed time ends the line it describes. */
  .live {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    overflow: hidden;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  .live > span {
    flex-shrink: 0;
  }
  .state {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .elapsed {
    margin-left: auto;
  }
  .live.text-error {
    color: var(--error);
  }
  /* The footer: how much work, on what, at what cache rate. */
  .foot {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    overflow: hidden;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  .foot > span {
    flex-shrink: 0;
  }
  .model {
    flex-shrink: 1;
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  /* A settled child is a plain mark; a live one is the shared tile meter. */
  .dot {
    width: 0.3rem;
    height: 0.3rem;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.45;
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
  /* Stop is an action, not a row: an icon with a button's edges, on the card's
     first line, so a runaway child dies without opening it. */
  .stop-action {
    align-self: flex-start;
    border: 1px solid var(--border);
    padding: 0.1875rem;
  }
  .stop-action:hover,
  .stop-action:focus-visible {
    background: var(--surface-hover);
  }
</style>
