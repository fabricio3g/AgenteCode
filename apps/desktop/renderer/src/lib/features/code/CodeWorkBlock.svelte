<svelte:options runes={true} />

<!--
  The work between two pieces of the reply, as one timeline (assistant-ui's
  tool timeline): thoughts and tool calls in the order they happened. It starts folded and opens when the reader asks; the header
  updates as work progresses. It folds to "4 steps · 2 files changed · 12.4s" with the touched files as
  chips — each opens its diff in the Changes pane. The live status line still names pending approvals and failures.

  This is L1: the smallest, quietest line on the page, with its rows hanging
  from the rail the shared disclosure draws for it.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { CodeChild } from '$shared/agente-protocol';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { formatToolDuration } from '$lib/utils/tool-ui';
  import { activitySummary } from './activity';
  import { codeWorkspace } from './workspace.svelte';
  import { changedFiles, isRunning, needsAttention, type WorkItem } from './work-blocks';
  import { disclosure, disclosureKey } from './disclosure.svelte';
  import CodeStepRow from './CodeStepRow.svelte';
  import CodeThoughtRow from './CodeThoughtRow.svelte';
  import Disclosure from './Disclosure.svelte';

  let {
    items,
    chatId,
    messageId,
    children,
    live = false
  }: {
    items: WorkItem[];
    chatId: string;
    messageId: string;
    /** The run's children, so a spawn's row finds the agent it started. */
    children?: CodeChild[];
    live?: boolean;
  } = $props();

  const approvals = $derived(new Set(approvalsStore.items.map((item) => item.requestId)));
  /** Settled approvals repeat their tool's row: leave them out. */
  const visible = $derived(items.filter((item) => !(item.step?.type === 'approval' && !needsAttention(item.step, approvals))));
  const files = $derived(changedFiles(visible));
  const steps = $derived(visible.flatMap((item) => (item.step ? [item.step] : [])));
  const running = $derived(steps.some(isRunning));

  /** The block is keyed by its first row, which is stable for the message. */
  const id = $derived(disclosureKey(chatId, messageId, visible[0]?.key ?? 'block'));
  const open = $derived(disclosure.isOpen(id, false));

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
    const parts = [$t('code.work.steps', { values: { n: visible.length } })];
    if (files.length) parts.push($t('code.work.files', { values: { n: files.length } }));
    return parts.join(' · ');
  });

  const lastKey = $derived(visible.at(-1)?.key);
</script>

{#snippet row(item: WorkItem)}
  {#if item.thinking !== undefined}
    <CodeThoughtRow
      text={item.thinking}
      live={live && item.key === lastKey}
      id={disclosureKey(chatId, messageId, item.key)}
    />
  {:else if item.step}
    <CodeStepRow
      step={item.step}
      {chatId}
      {children}
      id={disclosureKey(chatId, messageId, item.key)}
    />
  {/if}
{/snippet}

{#if visible.length === 1}
  <div class="min-w-0">{@render row(visible[0])}</div>
{:else if visible.length}
  <div class="work min-w-0">
    <Disclosure {id} level="block" chevron="leading" defaultOpen={false}>
      {#snippet header()}
        <span class="line min-w-0 truncate tabular-nums">{line}</span>
        <span class="flex-1"></span>
        {#if span !== undefined}<span class="span shrink-0 tabular-nums">{formatToolDuration(span)}</span>{/if}
      {/snippet}

      {#snippet body()}
        {#each visible as item (item.key)}{@render row(item)}{/each}
      {/snippet}
    </Disclosure>
    <!-- Folded, the chips are the one-click way to a file's diff. -->
    {#if files.length && !open}
      <div class="files">
        {#each files as file (file.path)}
          <button type="button" class="file-chip" title={file.path} onclick={() => codeWorkspace.showFileInChanges(file.path)}>
            <span>{file.name}</span>
            {#if file.additions}<span class="text-success">+{file.additions}</span>{/if}
            {#if file.deletions}<span class="text-error">−{file.deletions}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .line {
    font-size: var(--text-code);
  }
  .span {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem 0.125rem 1.875rem;
  }
  .file-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.5rem;
    border-radius: 0.375rem;
    background: var(--muted);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-code);
    color: var(--foreground);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .file-chip:hover {
    background: var(--surface-hover);
  }
</style>
