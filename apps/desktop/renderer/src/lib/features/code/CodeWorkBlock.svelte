<svelte:options runes={true} />

<!--
  The work between two pieces of the reply, as one timeline (assistant-ui's
  tool timeline): thoughts and tool calls in the order they happened. While
  it is the live block it stays open and grows; once the model moves on it
  folds to "4 steps · 2 files changed" with the touched files as chips —
  each opens its diff in the Changes pane. Approvals and failures never fold
  away.
-->

<script lang="ts">
  import { ChevronRight } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { activitySummary } from './activity';
  import { codeWorkspace } from './workspace.svelte';
  import { changedFiles, isRunning, needsAttention, type WorkItem } from './work-blocks';
  import CodeStepRow from './CodeStepRow.svelte';
  import CodeThoughtRow from './CodeThoughtRow.svelte';

  let { items, chatId, live = false }: { items: WorkItem[]; chatId: string; live?: boolean } = $props();

  const approvals = $derived(new Set(approvalsStore.items.map((item) => item.id)));
  /** Settled approvals repeat their tool's row: leave them out. */
  const visible = $derived(items.filter((item) => !(item.step?.type === 'approval' && !needsAttention(item.step, approvals))));
  const files = $derived(changedFiles(visible));
  const steps = $derived(visible.flatMap((item) => (item.step ? [item.step] : [])));

  let userToggled = $state(false);
  let open = $state(false);
  $effect(() => {
    if (!userToggled) open = live;
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

  /** A folded block still shows what needs you, and what is running. */
  const rows = $derived(open ? visible : visible.filter((item) => needsAttention(item.step, approvals) || isRunning(item.step)));
  const lastKey = $derived(visible.at(-1)?.key);
</script>

{#snippet row(item: WorkItem)}
  {#if item.thinking !== undefined}
    <CodeThoughtRow text={item.thinking} live={live && item.key === lastKey} />
  {:else if item.step}
    <CodeStepRow step={item.step} {chatId} />
  {/if}
{/snippet}

{#if visible.length === 1}
  <div class="min-w-0">{@render row(visible[0])}</div>
{:else if visible.length}
  <div class="work min-w-0">
    <button type="button" class="work-head ui-quiet-disclosure" aria-expanded={open} onclick={() => { userToggled = true; open = !open; }}>
      <ChevronRight class="size-3.5 shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
      <span class="min-w-0 truncate tabular-nums">{line}</span>
    </button>
    {#if rows.length}
      <div class="work-rows">
        {#each rows as item (item.key)}{@render row(item)}{/each}
      </div>
    {/if}
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
  .work-head {
    display: flex;
    max-width: 100%;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 0.5rem;
    font-size: var(--text-code);
    color: var(--muted-foreground);
    text-align: left;
    transition: color var(--motion-fast) var(--motion-ease);
  }
  /* Only the text answers the pointer: it brightens to say it opens. */
  .work-head:hover,
  .work-head:focus-visible {
    color: var(--foreground);
  }
  /* The block's rows hang from a hairline under the header's chevron. */
  .work-rows {
    display: flex;
    flex-direction: column;
    margin-left: 0.9375rem;
    padding-left: 0.25rem;
    border-left: 1px solid var(--border-subtle);
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
