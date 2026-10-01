<svelte:options runes={true} />

<!--
  Long tool output without a scroll box inside the transcript: past `max` it
  is cut with a soft fade and a "Show all" link, and opening it lets the block
  grow to full height. `tail` keeps the newest lines in view while cut, for
  output that is still streaming.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let { max = '16rem', tail = false, children }: { max?: string; tail?: boolean; children: Snippet } = $props();

  let inner = $state<HTMLDivElement>();
  let box = $state<HTMLDivElement>();
  let overflows = $state(false);
  let expanded = $state(false);

  $effect(() => {
    if (!inner || !box) return;
    const measure = () => {
      if (inner && box) overflows = inner.scrollHeight > box.clientHeight + 1 || expanded;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    measure();
    return () => observer.disconnect();
  });
</script>

<div class="clamp" class:is-cut={overflows && !expanded} class:tail>
  <div bind:this={box} class="clamp-box" style:max-height={expanded ? 'none' : max}>
    <div bind:this={inner}>{@render children()}</div>
  </div>
  {#if overflows}
    <button type="button" class="clamp-toggle" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
      {expanded ? $t('code.showLess') : $t('code.showAll')}
    </button>
  {/if}
</div>

<style>
  .clamp-box {
    overflow: hidden;
  }
  .clamp.tail .clamp-box {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }
  .clamp.is-cut .clamp-box {
    -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 2.5rem), transparent);
    mask-image: linear-gradient(to bottom, #000 calc(100% - 2.5rem), transparent);
  }
  .clamp.is-cut.tail .clamp-box {
    -webkit-mask-image: linear-gradient(to top, #000 calc(100% - 2.5rem), transparent);
    mask-image: linear-gradient(to top, #000 calc(100% - 2.5rem), transparent);
  }
  .clamp-toggle {
    display: block;
    padding: 0.25rem 0.625rem 0.375rem;
    font-size: 12px;
    color: var(--muted-foreground);
    transition: color var(--motion-fast) var(--motion-ease);
  }
  .clamp-toggle:hover,
  .clamp-toggle:focus-visible {
    color: var(--foreground);
  }
</style>
