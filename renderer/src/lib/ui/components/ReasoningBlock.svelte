<svelte:options runes={true} />

<script lang="ts">
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { Brain, ChevronDown } from 'lucide-svelte';

  interface Props {
    reasoning: string;
    status?: 'idle' | 'streaming' | 'error';
    timing?: number | null;
    totalElapsedSeconds?: number | null;
  }

  let { reasoning, status = 'idle', timing = 0, totalElapsedSeconds = 0 }: Props = $props();
  let open = $state(false);
  let userToggled = $state(false);
  let reasoningLiveEl = $state<HTMLDivElement | undefined>(undefined);

  $effect(() => {
    if (reasoningLiveEl && reasoning) {
      reasoningLiveEl.scrollTop = reasoningLiveEl.scrollHeight;
    }
  });

  $effect(() => {
    if (!userToggled) open = status === 'streaming';
  });

  const elapsed = $derived(Math.max(0, Number(timing || 0)));
  const total = $derived(Math.max(0, Number(totalElapsedSeconds || 0)));

  function toggle() {
    userToggled = true;
    open = !open;
  }
</script>

{#if reasoning}
  <div class="reasoning-block mb-4 w-full">
    <button type="button" class="cot-trigger" onclick={toggle}>
      <Brain class="h-4 w-4 shrink-0" />
      <span class="flex flex-1 items-center gap-2">
        <span class:text-shimmer={status === 'streaming'}>
          {status === 'streaming' ? 'Thinking…' : `Reasoning · ${elapsed.toFixed(1)}s`}
        </span>
        {#if status !== 'streaming' && total > 0}
          <span class="cot-total">Total · {total.toFixed(1)}s</span>
        {/if}
      </span>
      <ChevronDown class={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>

    {#if open}
      <div class="cot-body" transition:slide={{ duration: 180, easing: quintOut }}>
        <div class="cot-timeline-line"></div>
        <div bind:this={reasoningLiveEl} class="cot-content">
          <p>{reasoning}</p>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .reasoning-block { margin-top: 0.75rem; }

  .cot-trigger {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 500;
    transition: color 0.15s ease;
  }

  .cot-trigger:hover { color: var(--text); }

  .cot-body {
    display: grid;
    grid-template-columns: 2px 1fr;
    gap: 0.75rem;
    padding: 0.5rem 0;
  }

  .cot-total {
    margin-top: 0.08rem;
    color: var(--text-tertiary);
    font-size: 0.68rem;
    font-weight: 450;
  }

  .cot-timeline-line {
    width: 2px;
    background: var(--border);
    border-radius: 1px;
  }

  .cot-content p {
    color: var(--text-tertiary);
    font-size: 0.8125rem;
    line-height: 1.65;
    margin: 0;
  }
</style>
