<svelte:options runes={true} />

<!--
  One subagent in the right dock, opened from the pill over the composer.

  Read top to bottom the way people look: what it was asked (the title) and
  who is doing it (kind · model), what it is doing this second, the numbers
  (elapsed, cost; the tool calls count on their own heading) as label/value rows, then the work itself. While
  it runs the activity leads, since that is what changes; once it settles the
  answer leads, since that is what was wanted. ‹ › steps to the turn's other
  subagents without going back to the pill. The live run's copy wins over the
  saved one, so a working child is followed and a finished one stays readable.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ChevronLeft, ChevronRight, Copy, Square } from '$lib/icons';
  import type { ChatSession } from '$lib/types/chat';
  import { Button, IconButton } from '$lib/components/ui';
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import { invoke } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { formatToolDuration } from '$lib/utils/tool-ui';
  import { codeStore } from './code.svelte';
  import { cancelSubagentRun, childModelLabel, copySubagentAnswer, sessionChildren, subagentDisplay } from './subagent-row';
  import { subagentFocus } from './subagent-focus.svelte';
  import ToolStepRow from './ToolStepRow.svelte';
  import CodeErrorNotice from './CodeErrorNotice.svelte';

  let { chat, childId }: { chat: ChatSession; childId: string } = $props();

  const run = $derived(codeStore.runFor(chat.id));
  const all = $derived(sessionChildren(chat.messages, run?.children ?? []));
  const index = $derived(all.findIndex((item) => item.id === childId));
  const child = $derived(index >= 0 ? all[index] : undefined);
  let stoppedIds = $state<Record<string, boolean>>({});
  const stopped = $derived(!!(child && stoppedIds[child.id]));

  let now = $state(Date.now());
  const view = $derived(child ? subagentDisplay(child, { now }) : null);
  const running = $derived(!!view?.running);
  const failed = $derived(!!view?.failed);
  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(timer);
  });
  const facts = $derived(view ? [
    view.elapsed !== undefined ? { label: $t('context.worked'), value: formatToolDuration(view.elapsed) } : null,
    view.cost ? { label: $t('sessionHud.spend'), value: view.cost } : null
  ].filter((fact): fact is { label: string; value: string } => !!fact) : []);

  function step(by: number) {
    const next = all[(index + by + all.length) % all.length];
    if (next) subagentFocus.open(chat.id, next.id);
  }
  function stop() {
    if (!child) return;
    const id = child.id;
    void cancelSubagentRun(id, {
      invoke,
      setStopped: (value) => {
        if (value) stoppedIds = { ...stoppedIds, [id]: true };
        else { const next = { ...stoppedIds }; delete next[id]; stoppedIds = next; }
      },
      onError: (error) => toastStore.error(String(error))
    });
  }
  function copyText() {
    if (!view) return;
    void copySubagentAnswer(view.answer, {
      write: writeToClipboard,
      onSuccess: () => toastStore.success($t('chat.copied')),
      onError: (error) => toastStore.error(String(error))
    });
  }
</script>

{#snippet activity()}
  {#if child?.tools.length}
    <section>
      <h3 class="pane-heading">{$t('sessionHud.tools')}<span class="pane-count">{child.tools.length}</span></h3>
      {#each child.tools as tool (tool.id)}
        <ToolStepRow step={{ id: tool.id, type: 'tool', label: tool.name, toolName: tool.name, status: tool.status, output: tool.output }} id={`subagent-view:${child.id}:${tool.id}`} />
      {/each}
    </section>
  {/if}
{/snippet}

{#snippet answer()}
  {#if view?.reply}
    <section>
      <h3 class="pane-heading heading-row">{$t('sessionHud.answer')}
        {#if !running}<Button variant="plain" size="xs" class="copy" onclick={copyText}><Copy class="size-3" />{copy.actions.copy}</Button>{/if}
      </h3>
      <div class="reply"><RichContent content={view.reply} status={view.streamStatus} /></div>
    </section>
  {/if}
{/snippet}

<div class="pane-body subagent-view" data-subagent-view={childId}>
  {#if child && view}
    <header class="identity">
      <div class="who">
        <h2 class="title">{child.description || view.kindLabel}</h2>
        <p class="meta">{view.kindLabel}{#if child.model}<span title={child.model}>{' · '}{childModelLabel(child)}</span>{/if}</p>
      </div>
      {#if running && !stopped && !run?.stopping}
        <IconButton size="sm" variant="ghost" label={$t('code.stopSubagent')} title={$t('code.stopSubagent')} onclick={stop}><Square class="size-3.5" /></IconButton>
      {/if}
    </header>

    <div class="status-row">
      <p class="status" class:text-error={failed}>
        {#if running}<TileMeter mode={stopped || run?.stopping ? 'stopped' : 'busy'} /><span class="ui-shimmer-text">{view.activity ?? copy.status.working}</span>
        {:else}<span class="dot" data-state={child.status} aria-hidden="true"></span>{failed ? copy.tool.failed : copy.tool.done}{/if}
      </p>
      {#if all.length > 1}
        <span class="stepper">
          <IconButton quiet size="xs" label={$t('sessionHud.previous')} onclick={() => step(-1)}><ChevronLeft /></IconButton>
          <span class="count">{$t('sessionHud.position', { values: { n: index + 1, total: all.length } })}</span>
          <IconButton quiet size="xs" label={$t('sessionHud.next')} onclick={() => step(1)}><ChevronRight /></IconButton>
        </span>
      {/if}
    </div>

    <dl class="facts">
      {#each facts as fact (fact.label)}<div><dt>{fact.label}</dt><dd>{fact.value}</dd></div>{/each}
    </dl>

    {#if failed && view.errorDetail}
      {#key child.id}<CodeErrorNotice detail={view.errorDetail} />{/key}
    {/if}

    {#if running}{@render activity()}{@render answer()}{:else}{@render answer()}{@render activity()}{/if}

    {#if view.hasDistinctSummary && child.summary}
      <section><RichContent content={child.summary} /></section>
    {/if}
  {:else}
    <p class="pane-empty">{$t('sessionHud.gone')}</p>
  {/if}
</div>

<style>
  .identity { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0 0.5rem; }
  .who { flex: 1; min-width: 0; }
  .title { margin: 0; color: var(--foreground); font-size: var(--text-sm); font-weight: 550; line-height: 1.4; overflow-wrap: anywhere; }
  .meta { margin: 0.125rem 0 0; color: var(--muted-foreground); font-size: var(--text-xs); }

  .status-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-top: -0.375rem; padding: 0 0.5rem; }
  .status { display: flex; min-width: 0; align-items: center; gap: 0.5rem; margin: 0; color: var(--text-secondary); font-size: var(--text-xs); }
  .dot { width: 0.4375rem; height: 0.4375rem; border-radius: var(--radius-full); background: var(--muted-foreground); }
  .dot[data-state='error'] { background: var(--destructive); }
  .stepper { display: inline-flex; flex-shrink: 0; align-items: center; gap: 0.125rem; color: var(--muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }

  /* Label hard left, value hard right: the numbers line up down the column. */
  .facts { display: flex; flex-direction: column; gap: 0.125rem; margin: -0.25rem 0 0; padding: 0 0.5rem; font-size: var(--text-xs); }
  .facts div { display: flex; justify-content: space-between; gap: 1rem; padding: 0.125rem 0; }
  .facts dt { color: var(--muted-foreground); }
  .facts dd { margin: 0; color: var(--foreground); font-variant-numeric: tabular-nums; }

  .heading-row { justify-content: space-between; align-items: center; }
  .heading-row :global(.copy) { flex-shrink: 0; gap: 0.25rem; font-weight: 400; white-space: nowrap; }
  .reply { padding: 0 0.5rem; font-size: var(--text-sm); }
</style>
