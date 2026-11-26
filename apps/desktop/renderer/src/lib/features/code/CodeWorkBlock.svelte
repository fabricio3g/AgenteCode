<svelte:options runes={true} />

<!--
  The work between two pieces of the reply, as one timeline: thoughts and tool calls in the order they happened. Live and failed work opens by default; settled successful work folds unless the reader chose otherwise. The header
  updates as work progresses. It folds to "4 steps · 2 files changed · 12.4s"; the files themselves are
  listed once, in the turn's edited-files card.

  This is L1: the smallest, quietest line on the page, with its rows hanging
  from the rail the shared disclosure draws for it.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { CodeChild } from '$shared/agente-protocol';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { formatToolDuration } from '$lib/utils/tool-ui';
  import { activitySummary } from './activity';
  import { changedFiles, isRunning, needsAttention, workBlockKey, type WorkItem } from './work-blocks';
  import { disclosure, disclosureKey } from './disclosure-state.svelte';
  import { appearanceStore } from '$lib/stores/appearance.svelte';
  import { workEntries, workTotals, type WorkEntry } from './work-layouts';
  import CodeStepRow from './CodeStepRow.svelte';
  import CodeThoughtRow from './CodeThoughtRow.svelte';
  import Disclosure from './Disclosure.svelte';
  import FeedLayout from './work-layouts/FeedLayout.svelte';
  import FilesLayout from './work-layouts/FilesLayout.svelte';
  import PlanLayout from './work-layouts/PlanLayout.svelte';
  import ResearchLayout from './work-layouts/ResearchLayout.svelte';
  import ReviewLayout from './work-layouts/ReviewLayout.svelte';
  import TilesLayout from './work-layouts/TilesLayout.svelte';
  import TimelineLayout from './work-layouts/TimelineLayout.svelte';

  /** Settings → Appearance → Agent work: every layout but Agente's own rail. */
  const LAYOUTS = { feed: FeedLayout, files: FilesLayout, plan: PlanLayout, review: ReviewLayout, research: ResearchLayout, timeline: TimelineLayout, tiles: TilesLayout };

  let {
    items,
    chatId,
    messageId,
    children,
    live = false,
    thinkingLive,
    codeActions = true,
    activeChildIds = new Set<string>(),
    onstop
  }: {
    items: WorkItem[];
    chatId: string;
    messageId: string;
    /** The run's children, so a spawn's row finds the agent it started. */
    children?: CodeChild[];
    live?: boolean;
    thinkingLive?: boolean;
    codeActions?: boolean;
    activeChildIds?: ReadonlySet<string>;
    onstop?: () => void;
  } = $props();

  const approvals = $derived(new Set(approvalsStore.items.map((item) => item.requestId)));
  /** Settled approvals repeat their tool's row: leave them out. */
  const visible = $derived(items.filter((item) => !(item.step?.type === 'approval' && !needsAttention(item.step, approvals)) && !(item.step?.toolName === 'task' && item.step.subagentId && activeChildIds.has(item.step.subagentId))));
  /** A step waiting on you never folds away: its Allow / Deny stay on screen, under the block. */
  const waiting = $derived(visible.filter((item) => !!item.step && (item.step.status === 'awaiting_approval' || approvals.has(item.step.id))));
  /**
   * The call an approval is holding. The engine reports the call and the
   * request as two steps, so "Edit src/index.ts" showed twice — once running,
   * once asking. While it waits, the request row speaks for it.
   */
  const held = $derived.by(() => {
    const ids = new Set<string>();
    for (const item of waiting) {
      const blocked = [...visible].reverse().find((candidate) => candidate.step && candidate.step.type !== 'approval' && isRunning(candidate.step) && candidate.step.toolName === item.step?.toolName && !ids.has(candidate.step.id));
      if (blocked?.step) ids.add(blocked.step.id);
    }
    return ids;
  });
  const folded = $derived(visible.filter((item) => !waiting.includes(item) && !(item.step && held.has(item.step.id))));
  const files = $derived(changedFiles(visible));
  const steps = $derived(visible.flatMap((item) => (item.step ? [item.step] : [])));
  const running = $derived(steps.some(isRunning));
  const defaultOpen = $derived(live || steps.some((step) => step.status === 'error'));

  /**
   * The block's own key: namespaced away from its first row's, which is what
   * the reader's choice for that row (a step, or the card of a spawn) hangs on.
   */
  const id = $derived(disclosureKey(chatId, messageId, workBlockKey(visible[0]?.key)));

  /**
   * How long the whole run of work took: from the first step that started to the
   * last one that ended. Only once nothing is running — while it is live the
   * header says what is happening, which is more use than a stopwatch.
   */
  const span = $derived.by(() => {
    if (running) return undefined;
    const bounds = steps
      .filter((step) => step.startedAt !== undefined && step.durationMs !== undefined)
      .map((step) => [step.startedAt!, step.startedAt! + step.durationMs!] as const);
    if (!bounds.length) return undefined;
    return Math.max(...bounds.map(([, end]) => end)) - Math.min(...bounds.map(([start]) => start));
  });

  /** Live: what it has done and is doing ("edited 1 file · running 1 command"); done: "4 steps · 2 files changed". */
  const line = $derived.by(() => {
    if (live) {
      const text = activitySummary(steps).counts.map(({ kind, count, running }) => $t(`code.activity.${running ? 'running' : 'done'}.${kind}`, { values: { n: count } })).join(' · ');
      if (text) return text.charAt(0).toUpperCase() + text.slice(1);
    }
    const parts = [$t('code.work.steps', { values: { n: folded.length } })];
    if (files.length) parts.push($t('code.work.files', { values: { n: files.length } }));
    return parts.join(' · ');
  });

  const lastKey = $derived(visible.at(-1)?.key);

  const Layout = $derived(LAYOUTS[appearanceStore.prefs.agentStyle as keyof typeof LAYOUTS]);
  const entries = $derived(workEntries(folded));
  const totals = $derived(workTotals(entries));
  const entryKey = (entry: WorkEntry) => disclosureKey(chatId, messageId, entry.key);
</script>

{#snippet row(item: WorkItem)}
  {#if item.thinking !== undefined}
    <CodeThoughtRow
      text={item.thinking}
      live={(thinkingLive ?? live) && item.key === lastKey}
      id={disclosureKey(chatId, messageId, item.key)}
    />
  {:else if item.step}
    <CodeStepRow
      step={item.step}
      {chatId}
      {children}
      {onstop}
      {codeActions}
      id={disclosureKey(chatId, messageId, item.key)}
    />
  {/if}
{/snippet}

{#snippet detail(item: WorkItem)}
  {#if item.step}
    <CodeStepRow step={item.step} {chatId} {children} {onstop} {codeActions} bare id={disclosureKey(chatId, messageId, item.key)} />
  {/if}
{/snippet}

{#if folded.length === 1}
  <div class="work work-single min-w-0">{@render row(folded[0])}</div>
{:else if folded.length && Layout}
  <div class="work work-layout min-w-0">
    <Layout
      {entries}
      {totals}
      {line}
      {span}
      {live}
      open={disclosure.isOpen(id, defaultOpen)}
      ontoggle={() => disclosure.toggle(id, defaultOpen)}
      {row}
      {detail}
      isOpen={(entry) => disclosure.isOpen(entryKey(entry), false)}
      toggleEntry={(entry) => disclosure.toggle(entryKey(entry), false)}
    />
  </div>
{:else if folded.length}
  <div class="work work-multi min-w-0">
    <Disclosure {id} level="block" chevron="leading" {defaultOpen}>
      {#snippet header()}
        <span class="min-w-0 truncate tabular-nums">{line}</span>
        <span class="flex-1"></span>
        {#if span !== undefined}<span class="span shrink-0 tabular-nums">{formatToolDuration(span)}</span>{/if}
      {/snippet}

      {#snippet body()}
        {#each folded as item (item.key)}{@render row(item)}{/each}
      {/snippet}
    </Disclosure>
  </div>
{/if}
{#each waiting as item (item.key)}<div class="work work-waiting min-w-0">{@render row(item)}</div>{/each}

<style>
  .span {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
</style>
