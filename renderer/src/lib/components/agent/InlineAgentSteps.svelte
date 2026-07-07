<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown } from 'lucide-svelte';
  import type { AgentStep } from '$lib/types/chat';
  import ToolCallRow from './ToolCallRow.svelte';

  interface Props { steps: AgentStep[]; status?: string; totalElapsedSeconds?: number }

  let { steps, status = 'idle', totalElapsedSeconds = 0 }: Props = $props();

  const work = $derived(steps.filter((s) =>
    s.type === 'thinking' || s.type === 'planning' || s.type === 'tool' ||
    s.type === 'executing' || s.type === 'writing' || s.type === 'reading' ||
    s.type === 'searching' || s.type === 'preview' || s.type === 'approval'
  ));
  const done = $derived(work.filter((s) => s.status === 'done').length);
  const running = $derived(work.filter((s) => s.status === 'running').length);
  const errors = $derived(work.filter((s) => s.status === 'error').length);
  const isStreaming = $derived(status === 'streaming');
  let collapsed = $state(false);
  const MAX = 5;
  const shown = $derived(collapsed ? work.slice(-MAX) : work);
  const hidden = $derived(work.length - MAX);
</script>

{#if isStreaming && !work.length}
  <div class="working">
    <span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
    {#if totalElapsedSeconds > 0}
      <span class="elapsed">{totalElapsedSeconds.toFixed(1)}s</span>
    {/if}
  </div>
{/if}

{#if work.length}
  <section class="group">
    {#if work.length > MAX}
      <button class="toggle" onclick={() => (collapsed = !collapsed)}>
        <ChevronDown class="icon {collapsed ? 'flip' : ''}" />
        {collapsed ? `Show all ${work.length} steps (+${hidden} hidden)` : `Show last ${MAX} of ${work.length} steps`}
      </button>
    {/if}
    <div class="list">
      {#each shown as step (step.id)}
        <ToolCallRow {step} />
      {/each}
    </div>
    <div class="summary">
      {errors ? `${done} steps · ${errors} error` : done ? `${done} step${done === 1 ? '' : 's'}` : `${work.length} step${work.length === 1 ? '' : 's'}`}
    </div>
  </section>
{/if}

<style>
  .working { display: flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.4rem; color: var(--text-muted); font-size: 0.72rem; }
  .dots { display: flex; gap: 3px; }
  .dot { width: 4px; height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--text-muted) 40%, transparent); animation: pulse 1.4s ease-in-out infinite; }
  .dot:nth-child(2) { animation-delay: 200ms; }
  .dot:nth-child(3) { animation-delay: 400ms; }
  @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
  .elapsed { opacity: 0.7; font-variant-numeric: tabular-nums; }
  .group { display: flex; flex-direction: column; gap: 0.05rem; margin: 0.25rem 0; width: min(46rem, 100%); }
  .toggle { display: flex; align-items: center; gap: 0.3rem; border: 0; background: transparent; color: var(--text-muted); padding: 0.22rem 0.4rem; font-size: 0.7rem; font-weight: 580; cursor: pointer; border-radius: 0.35rem; }
  .toggle:hover { color: var(--text-secondary); background: color-mix(in srgb, var(--surface-hover) 50%, transparent); }
  .toggle .icon { width: 0.75rem; height: 0.75rem; transition: transform 0.15s; }
  .toggle .icon.flip { transform: rotate(180deg); }
  .list { display: flex; flex-direction: column; }
  .summary { padding: 0.15rem 0.4rem; color: var(--text-muted); font-size: 0.66rem; font-weight: 580; opacity: 0.75; }
</style>
