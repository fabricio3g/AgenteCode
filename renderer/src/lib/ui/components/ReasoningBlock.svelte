<svelte:options runes={true} />

<script lang="ts">
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { Brain, ChevronDown, ChevronUp } from 'lucide-svelte';
  import MorphingHexagon from './MorphingHexagon.svelte';

  interface Props {
    reasoning: string;
    status?: 'idle' | 'streaming' | 'error';
    timing?: number | null;
  }

  let { reasoning, status = 'idle', timing = 0 }: Props = $props();
  let open = $state(false);
  let userToggled = $state(false);
  let reasoningLiveEl = $state<HTMLDivElement | undefined>(undefined);

  $effect(() => {
    if (reasoningLiveEl && reasoning) {
      reasoningLiveEl.scrollTop = reasoningLiveEl.scrollHeight;
    }
  });

  $effect(() => {
    if (!userToggled) {
      open = status === 'streaming';
    }
  });

  function label() {
    const safeTiming = Number(timing || 0);
    if (status === 'streaming') return 'Thinking...';
    return safeTiming > 0 ? `Thought for ${safeTiming.toFixed(1)}s` : 'Reasoning';
  }

  function toggle() {
    userToggled = true;
    open = !open;
  }
</script>

{#if reasoning}
  <div class="reasoning-block mb-4 w-full">
    <button
      class="reasoning-toggle flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition"
      onclick={toggle}
    >
      <Brain class={`h-4 w-4 shrink-0 ${status === 'streaming' ? 'animate-pulse' : ''}`} />
      <span class="flex-1 text-sm font-medium">{label()}</span>
      {#if status === 'streaming'}
        <MorphingHexagon size={16} />
      {/if}
      {#if open}
        <ChevronUp class="h-4 w-4 shrink-0 opacity-50" />
      {:else}
        <ChevronDown class="h-4 w-4 shrink-0 opacity-50" />
      {/if}
    </button>

    {#if open}
      <div class="reasoning-content mt-1 overflow-hidden rounded-lg" transition:slide={{ duration: 200, easing: quintOut }}>
        <div bind:this={reasoningLiveEl} class="max-h-64 overflow-y-auto px-4 py-3">
          <p class="whitespace-pre-wrap text-sm leading-relaxed">{reasoning}</p>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .reasoning-toggle {
    color: var(--text-secondary);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
  }

  .reasoning-toggle:hover {
    background: var(--surface-highlight);
    border-color: var(--border-strong);
  }

  .reasoning-content {
    background: var(--surface-highlight);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
  }

  .reasoning-content p {
    color: var(--text-tertiary);
  }

</style>
