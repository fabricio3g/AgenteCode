<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown } from 'lucide-svelte';
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
  const errors = $derived(work.filter((s) => s.status === 'error').length);
  const needsAttention = $derived(
    work.some((s) => s.status === 'awaiting_approval' || s.status === 'error')
  );

  let userOpen = $state<boolean | null>(null);

  // Default collapsed after run — open only for errors/approvals or tiny lists
  const defaultOpen = $derived(needsAttention || work.length === 1);
  const open = $derived(userOpen !== null ? userOpen : defaultOpen);
  const count = $derived(work.length);

  const groupLabel = $derived.by(() => {
    if (errors) return `${done} done · ${errors} error${errors === 1 ? '' : 's'}`;
    if (count === 0) return 'Steps';
    if (totalElapsedSeconds > 0) {
      return `${count} step${count === 1 ? '' : 's'} · ${totalElapsedSeconds < 10 ? totalElapsedSeconds.toFixed(1) : Math.floor(totalElapsedSeconds)}s`;
    }
    return `${count} step${count === 1 ? '' : 's'}`;
  });

  function toggle() {
    userOpen = !open;
  }
</script>

{#if work.length && status !== 'streaming'}
  <section
    class="aui-tool-group-root"
    data-variant={variant}
    data-slot="tool-group-root"
    data-state={open ? 'open' : 'closed'}
  >
    <button
      type="button"
      class="aui-tool-group-trigger quiet"
      data-slot="tool-group-trigger"
      onclick={toggle}
    >
      <span class="aui-tool-group-trigger-label">{groupLabel}</span>
      <ChevronDown class={`aui-tool-fallback-chevron size-3 ${open ? '' : 'is-closed'}`} />
    </button>

    {#if open}
      <div
        class="aui-tool-group-content"
        transition:slide={{ duration: 160, easing: quintOut }}
        data-slot="tool-group-content"
      >
        {#each work as step (step.id)}
          <ToolCallRow {step} />
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  :global(.aui-tool-group-trigger.quiet) {
    color: var(--muted-foreground);
    font-weight: 500;
  }
</style>
