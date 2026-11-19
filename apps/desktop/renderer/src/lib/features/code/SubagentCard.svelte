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
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { Bot, Copy, ListChecks, Square, Telescope } from '$lib/icons';
  import type { CodeChild } from '$shared/agente-protocol';
  import { invoke } from '$lib/services/bridge';
  import { copy } from '$lib/copy';
  import { codeStore } from './code.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { formatToolDuration, titleCaseToolName } from '$lib/utils/tool-ui';
  import ClampedBlock from './ClampedBlock.svelte';
  import CodeStepRow from './CodeStepRow.svelte';
  import CodeErrorNotice from './CodeErrorNotice.svelte';
  import Disclosure from './Disclosure.svelte';
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import { childActivity, childElapsedMs, childModelLabel } from './subagent-row';
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

  Identity and live status share a compact row. Stop remains accessible without
  opening it, and the work and model details stay just below when available.
-->
<Disclosure {id} level="subagent" chevron="leading" defaultOpen={false}>
  {#snippet header()}
    <span class="card min-w-0">
      <span class="summary">
        <span class="identity min-w-0">
          <Icon class="kind-icon size-3.5 shrink-0" />
          <span class="kind shrink-0">{kindLabel}</span>
          {#if child.description}<span class="description min-w-0 truncate">· {child.description}</span>{/if}
        </span>
        <span class="live min-w-0" class:text-error={failed}>
          {#if running}<TileMeter mode={meter} />{:else}<span class="dot" aria-hidden="true"></span>{/if}
          <span class="state min-w-0" class:ui-shimmer-text={running}>{status}</span>
          {#if elapsed !== undefined}<span class="elapsed shrink-0 tabular-nums">· {formatToolDuration(elapsed)}</span>{/if}
        </span>
      </span>
    </span>
  {/snippet}

  {#snippet actions()}
    {#if running && !pending && !stopping}
      <IconButton label={$t('code.stopSubagent')} size="xs" variant="ghost"
        type="button"
        class={uiClass("card-action stop-action", "ui-local-b304b300")}
        title={$t('code.stopSubagent')}

        onclick={stop}
      ><Square class="size-3" /></IconButton>
    {/if}
  {/snippet}

  {#snippet body()}
    {#if toolCount || child.model || spendDetail || cost}
      <div class="foot min-w-0">
        {#if toolCount}<span class="tabular-nums">{$t('code.subagent.tools', { values: { n: toolCount } })}</span>{/if}
        {#if child.model}<span class="model min-w-0 truncate" title={child.model}>{childModelLabel(child)}</span>{/if}
        {#if spendDetail}<span class="tabular-nums">{spendDetail}</span>{:else if cost}<span class="tabular-nums">{cost}</span>{/if}
      </div>
    {/if}
    {#if failed && errorDetail}<CodeErrorNotice detail={errorDetail} />{/if}
    {#if reply}
      <div>
        <ClampedBlock max="22rem" tail={running}>
          <RichContent content={reply} status={streamStatus} />
        </ClampedBlock>
        {#if !running}
          <UiButton variant="plain" type="button" class={uiClass("card-action", "ui-local-b304b300")} onclick={copyText}><Copy class="size-3" />{copy.actions.copy}</UiButton>
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
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    width: 100%;
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    min-width: 0;
  }
  .identity {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex: 1 1 auto;
  }
  .description {
    color: var(--muted-foreground);
  }
  .live {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    overflow: hidden;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    flex: 0 1 auto;
    max-width: 45%;
  }
  .state {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .elapsed {
    flex-shrink: 0;
  }
  .live.text-error {
    color: var(--error);
  }
  .live:not(.text-error) :global(.tile-rain) {
    color: var(--work-accent);
  }
  /* The footer: how much work, on what, at what cache rate. */
  .foot {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    overflow: hidden;
    font-size: var(--text-xs);
    color: var(--text-secondary);
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
  :global(.card-action.ui-local-b304b300) {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-md);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    transition: color var(--motion-fast) var(--motion-ease);
  }
  :global(.card-action:hover.ui-local-b304b300),
  :global(.card-action:focus-visible.ui-local-b304b300) {
    color: var(--foreground);
  }
  /* Stop is an action, not a row: an icon with a button's edges, on the card's
     first line, so a runaway child dies without opening it. */
  :global(.stop-action.ui-local-b304b300) {
    align-self: flex-start;
    padding: 0.1875rem;
  }
  :global(.stop-action:hover.ui-local-b304b300),
  :global(.stop-action:focus-visible.ui-local-b304b300) {
    background: var(--surface-hover);
  }
</style>
