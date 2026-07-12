<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, Loader2 } from 'lucide-svelte';
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import type { AgentStep } from '$lib/types/chat';
  import ToolCallRow from './ToolCallRow.svelte';

  interface Props {
    steps: AgentStep[];
    status?: string;
    totalElapsedSeconds?: number;
    variant?: 'outline' | 'ghost' | 'muted';
  }

  let {
    steps,
    status = 'idle',
    totalElapsedSeconds = 0,
    variant = 'outline'
  }: Props = $props();

  const work = $derived(
    steps.filter(
      (s) =>
        s.type === 'thinking' ||
        s.type === 'planning' ||
        s.type === 'tool' ||
        s.type === 'executing' ||
        s.type === 'writing' ||
        s.type === 'reading' ||
        s.type === 'searching' ||
        s.type === 'preview' ||
        s.type === 'approval' ||
        s.type === 'coding'
    )
  );

  const done = $derived(work.filter((s) => s.status === 'done').length);
  const running = $derived(work.filter((s) => s.status === 'running' || s.status === 'pending').length);
  const errors = $derived(work.filter((s) => s.status === 'error').length);
  const isStreaming = $derived(status === 'streaming');
  const active = $derived(running > 0 || isStreaming);

  let userOpen = $state<boolean | null>(null);

  // assistant-ui ToolGroup: expanded while active / small lists; otherwise collapsible
  const defaultOpen = $derived(active || work.length <= 5);
  const open = $derived(userOpen !== null ? userOpen : defaultOpen);

  const count = $derived(work.length);
  const groupLabel = $derived(`${count} tool ${count === 1 ? 'call' : 'calls'}`);

  function toggle() {
    userOpen = !open;
  }
</script>

{#if isStreaming && !work.length}
  <div class="working">
    <Loader2 class="size-3 animate-spin" />
    <span class="aui-shimmer-host">
      <span>Working…</span>
      <span class="aui-shimmer" aria-hidden="true">Working…</span>
    </span>
    {#if totalElapsedSeconds > 0}
      <span class="elapsed">{totalElapsedSeconds.toFixed(1)}s</span>
    {/if}
  </div>
{/if}

{#if work.length}
  <section
    class="aui-tool-group-root"
    data-variant={variant}
    data-slot="tool-group-root"
    data-state={open ? 'open' : 'closed'}
  >
    <button
      type="button"
      class="aui-tool-group-trigger"
      data-slot="tool-group-trigger"
      onclick={toggle}
    >
      {#if active}
        <Loader2 class="size-3 shrink-0 animate-spin" style="animation-duration: 0.6s" />
      {/if}
      <span class="aui-tool-group-trigger-label aui-shimmer-host">
        <span>{groupLabel}</span>
        {#if active}
          <span class="aui-shimmer" aria-hidden="true">{groupLabel}</span>
        {/if}
      </span>
      <ChevronDown class={`aui-tool-fallback-chevron size-3 ${open ? '' : 'is-closed'}`} />
    </button>

    {#if open}
      <div
        class="aui-tool-group-content"
        transition:slide={{ duration: 180, easing: quintOut }}
        data-slot="tool-group-content"
      >
        {#each work as step (step.id)}
          <ToolCallRow {step} />
        {/each}
      </div>
    {/if}

    <div class="aui-tool-group-summary">
      {#if errors}
        {done} done · {errors} error{errors === 1 ? '' : 's'}
      {:else if done}
        {done} step{done === 1 ? '' : 's'}
      {:else}
        {count} step{count === 1 ? '' : 's'}
      {/if}
    </div>
  </section>
{/if}

<style>
  .working {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.25rem;
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }

  .elapsed {
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }
</style>
