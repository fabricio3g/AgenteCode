<svelte:options runes={true} />

<!--
  The model's reasoning, as quiet as the activity lines around it: one muted
  line ("Thinking…" while it streams, "Thought for 12s" after) that opens
  the text beside a thin rule. Open while streaming, closed once done,
  unless the reader chose otherwise.
-->

<script lang="ts">
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { ChevronRight } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { formatReasoningDuration } from '$lib/utils/tool-ui';

  interface Props {
    reasoning: string;
    status?: 'idle' | 'streaming' | 'error' | string;
    timing?: number | null;
    totalElapsedSeconds?: number | null;
    autoOpenOnStreaming?: boolean;
    /** Kept for callers; every variant now looks the same. */
    variant?: 'outline' | 'ghost' | 'muted';
  }

  let { reasoning, status = 'idle', timing = 0, autoOpenOnStreaming = true }: Props = $props();

  let userOpen = $state<boolean | null>(null);
  let textEl = $state<HTMLDivElement | undefined>(undefined);

  const streaming = $derived(status === 'streaming');
  const isOpen = $derived(userOpen !== null ? userOpen : autoOpenOnStreaming ? streaming : false);
  const elapsed = $derived(Math.max(0, Number(timing || 0)));
  const label = $derived(
    streaming
      ? $t('thread.reasoning.thinking')
      : elapsed > 0
        ? $t('thread.reasoning.thoughtFor', { values: { s: formatReasoningDuration(elapsed) } })
        : $t('thread.reasoning.thought')
  );

  // Follow the live text while it streams open.
  $effect(() => {
    void reasoning;
    if (streaming && isOpen && userOpen === null && textEl) textEl.scrollTop = textEl.scrollHeight;
  });
</script>

{#if reasoning}
  <div class="reasoning" data-state={isOpen ? 'open' : 'closed'}>
    <button type="button" class="reasoning-line ui-quiet-disclosure" aria-expanded={isOpen} onclick={() => (userOpen = !isOpen)}>
      <ChevronRight class="size-3 shrink-0 transition-transform {isOpen ? 'rotate-90' : ''}" />
      <span class="ui-shimmer-text" class:shimmer={streaming}>{label}</span>
    </button>
    {#if isOpen}
      <div bind:this={textEl} class="reasoning-text" transition:slide={{ duration: 180, easing: quintOut }} aria-busy={streaming}>
        {reasoning}
      </div>
    {/if}
  </div>
{/if}

<style>
  .reasoning { min-width: 0; }
  .reasoning-line {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 0.375rem;
    border-radius: var(--radius-md);
    padding: 0.25rem 0.375rem 0.25rem 0.25rem;
    color: var(--muted-foreground);
    font-size: 12.5px;
    transition: color var(--motion-fast);
  }
  .reasoning-line:hover,
  .reasoning-line:focus-visible {
    color: var(--foreground);
  }
  .reasoning-text {
    margin: 0.25rem 0 0.25rem 0.55rem;
    max-height: 16rem;
    overflow-y: auto;
    border-left: 1px solid var(--border-subtle);
    padding: 0.125rem 0 0.125rem 0.75rem;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
  }
  /* The running label shimmers through the one shared rule (app.css). */
  .shimmer {
    --shimmer-duration: 1.6s;
  }
</style>
