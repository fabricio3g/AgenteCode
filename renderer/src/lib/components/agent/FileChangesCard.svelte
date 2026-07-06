<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, FileCode2, GitCompare } from 'lucide-svelte';
  import type { CodeAgentDiffStat } from '$lib/types/chat';

  interface Props {
    stats: CodeAgentDiffStat[];
  }

  let { stats }: Props = $props();
  let expanded = $state<Set<string>>(new Set());

  const totalAdditions = $derived(stats.reduce((sum, stat) => sum + stat.additions, 0));
  const totalDeletions = $derived(stats.reduce((sum, stat) => sum + stat.deletions, 0));

  function toggle(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expanded = next;
  }

  function collapseAll() {
    expanded = new Set();
  }

  function expandAll() {
    expanded = new Set(stats.map((stat) => stat.path));
  }

  function contentFor(stat: CodeAgentDiffStat) {
    if (stat.kind === 'deleted') return stat.before || '';
    return stat.after || '';
  }
</script>

{#if stats.length}
  <section class="changes-card">
    <header class="changes-header">
      <div class="changes-title"><GitCompare class="h-3.5 w-3.5" />CHANGED FILES ({stats.length})</div>
      <div class="changes-counts"><span class="adds">+{totalAdditions}</span><span class="dels">-{totalDeletions}</span></div>
      <button type="button" onclick={collapseAll}>Collapse all</button>
      <button type="button" onclick={expandAll}>View diff</button>
    </header>
    <div class="changes-list">
      {#each stats as stat (`${stat.kind}:${stat.path}`)}
        {@const isOpen = expanded.has(stat.path)}
        <article class="change-row" class:open={isOpen}>
          <button type="button" class="change-main" onclick={() => toggle(stat.path)}>
            <ChevronDown class={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            <FileCode2 class="h-3.5 w-3.5" />
            <span class="path">{stat.path}</span>
            <span class="kind {stat.kind}">{stat.kind}</span>
            <span class="counts"><span class="adds">+{stat.additions}</span><span class="dels">-{stat.deletions}</span></span>
          </button>
          {#if isOpen}
            <pre>{contentFor(stat).slice(0, 8000)}{contentFor(stat).length > 8000 ? '\n\n... (truncated)' : ''}</pre>
          {/if}
        </article>
      {/each}
    </div>
  </section>
{/if}

<style>
  .changes-card {
    margin-top: 0.8rem;
    width: min(46rem, 100%);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: color-mix(in srgb, var(--surface-hover) 34%, transparent);
  }

  .changes-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    padding: 0.6rem 0.7rem;
  }

  .changes-title {
    display: inline-flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.35rem;
    color: var(--text-muted);
    font-size: 0.7rem;
    font-weight: 760;
    letter-spacing: 0.08em;
  }

  .changes-counts,
  .counts {
    display: inline-flex;
    gap: 0.35rem;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    font-weight: 720;
  }

  .adds { color: var(--success, #16a34a); }
  .dels { color: var(--error); }

  .changes-header button {
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-secondary);
    padding: 0.28rem 0.55rem;
    font-size: 0.72rem;
    font-weight: 700;
  }

  .change-row + .change-row {
    border-top: 1px solid color-mix(in srgb, var(--border) 54%, transparent);
  }

  .change-main {
    display: grid;
    width: 100%;
    grid-template-columns: auto auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 0.45rem;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    padding: 0.55rem 0.7rem;
    text-align: left;
  }

  .change-main:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 0.78rem;
  }

  .kind {
    border-radius: 999px;
    background: var(--surface);
    padding: 0.18rem 0.38rem;
    font-size: 0.58rem;
    font-weight: 780;
    text-transform: uppercase;
  }

  .kind.created { color: var(--success, #16a34a); }
  .kind.modified { color: var(--primary); }
  .kind.deleted { color: var(--error); }

  pre {
    margin: 0;
    max-height: 20rem;
    overflow: auto;
    border-top: 1px solid color-mix(in srgb, var(--border) 54%, transparent);
    background: color-mix(in srgb, var(--surface) 64%, transparent);
    color: var(--text-secondary);
    padding: 0.65rem 0.8rem;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.5;
    white-space: pre-wrap;
  }
</style>
