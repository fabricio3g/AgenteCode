<svelte:options runes={true} />

<script lang="ts">
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { Brain, ChevronDown } from 'lucide-svelte';
  import { formatReasoningDuration } from '$lib/utils/tool-ui';

  interface Props {
    reasoning: string;
    status?: 'idle' | 'streaming' | 'error' | string;
    timing?: number | null;
    totalElapsedSeconds?: number | null;
    autoOpenOnStreaming?: boolean;
    variant?: 'outline' | 'ghost' | 'muted';
  }

  let {
    reasoning,
    status = 'idle',
    timing = 0,
    totalElapsedSeconds = 0,
    autoOpenOnStreaming = true,
    variant = 'outline'
  }: Props = $props();

  let userOpen = $state<boolean | null>(null);
  let reasoningLiveEl = $state<HTMLDivElement | undefined>(undefined);

  const streaming = $derived(status === 'streaming');
  const isOpen = $derived(
    userOpen !== null ? userOpen : (autoOpenOnStreaming ? streaming : false)
  );
  const isPreview = $derived(streaming && isOpen && userOpen === null);

  const elapsed = $derived(Math.max(0, Number(timing || 0)));
  const total = $derived(Math.max(0, Number(totalElapsedSeconds || 0)));
  const durationText = $derived(
    !streaming && elapsed > 0 ? ` (${formatReasoningDuration(elapsed)}s)` : ''
  );
  const triggerLabel = $derived(
    streaming ? 'Reasoning' : `Reasoning${durationText}`
  );

  function toggle() {
    userOpen = !isOpen;
  }

  $effect(() => {
    if (!isPreview || !reasoningLiveEl) return;
    reasoningLiveEl.scrollTop = reasoningLiveEl.scrollHeight;
  });

  $effect(() => {
    // re-pin when reasoning grows during streaming preview
    if (isPreview && reasoning && reasoningLiveEl) {
      reasoningLiveEl.scrollTop = reasoningLiveEl.scrollHeight;
    }
  });
</script>

{#if reasoning}
  <div
    class="aui-reasoning-root"
    data-slot="reasoning-root"
    data-variant={variant}
    data-state={isOpen ? 'open' : 'closed'}
  >
    <button type="button" class="aui-reasoning-trigger" onclick={toggle} data-slot="reasoning-trigger">
      <Brain class="size-4 shrink-0" />
      <span class="aui-shimmer-host tabular-nums">
        <span>{triggerLabel}</span>
        {#if streaming}
          <span class="aui-shimmer" aria-hidden="true">{triggerLabel}</span>
        {/if}
      </span>
      {#if !streaming && total > 0 && Math.abs(total - elapsed) >= 0.25}
        <span class="text-xs opacity-70">Total · {total.toFixed(1)}s</span>
      {/if}
      <ChevronDown class={`aui-tool-fallback-chevron mt-0.5 ${isOpen ? '' : 'is-closed'}`} />
    </button>

    {#if isOpen}
      <div
        class="aui-reasoning-content"
        transition:slide={{ duration: 200, easing: quintOut }}
        data-slot="reasoning-content"
        aria-busy={streaming}
      >
        <div class="aui-reasoning-fade top" aria-hidden="true"></div>
        <div bind:this={reasoningLiveEl} class="aui-reasoning-text" data-slot="reasoning-text">
          <div class="space-y-2">
            <p class="m-0 whitespace-pre-wrap">{reasoning}</p>
          </div>
        </div>
        {#if isPreview}
          <div class="aui-reasoning-fade bottom" aria-hidden="true"></div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
