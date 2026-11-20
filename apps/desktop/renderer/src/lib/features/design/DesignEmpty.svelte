<svelte:options runes={true} />

<!--
  The canvas before the first page exists: three faint screen skeletons and a
  calm title. While the agent is working on the first screen the skeletons
  shimmer; under reduced motion they hold still.
-->

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { reducedMotion } from '$lib/utils/motion.svelte';

  const generating = $derived(Boolean(appStore.currentChatGenerating));
</script>

<div class="empty" class:generating class:still={reducedMotion.value} role="status" aria-live="polite">
  <div class="skeletons" aria-hidden="true">
    <span class="screen back"><span class="bar wide"></span><span class="block"></span><span class="row"></span></span>
    <span class="screen mid"><span class="bar"></span><span class="block tall"></span><span class="row short"></span><span class="row"></span></span>
    <span class="screen front"><span class="bar wide"></span><span class="block"></span><span class="row"></span><span class="row short"></span></span>
  </div>

  {#if generating}
    <p class="title ui-shimmer-text">{copy.design.empty.sketching}</p>
  {:else}
    <p class="title">{copy.design.empty.title}</p>
    <p class="hint">{copy.design.empty.hint}</p>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    margin: auto;
    max-width: 22rem;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
    padding: 1.5rem 1rem;
    text-align: center;
  }

  .skeletons {
    position: relative;
    width: 15rem;
    height: 9.5rem;
  }

  .screen {
    position: absolute;
    display: flex;
    flex-direction: column;
    gap: 0.4375rem;
    padding: 0.75rem;
    border: 1px solid var(--float-border);
    border-radius: var(--radius-md);
    background: var(--card);
    box-shadow: var(--control-shadow);
    opacity: 0.9;
  }

  .screen.back { top: 0; left: 0; width: 11rem; height: 7.5rem; opacity: 0.45; }
  .screen.mid { top: 0.9rem; left: 2rem; width: 11rem; height: 7.5rem; opacity: 0.7; }
  .screen.front { top: 1.8rem; left: 4rem; width: 11rem; height: 7.5rem; }

  .bar,
  .block,
  .row {
    display: block;
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--foreground) 8%, transparent);
  }

  .bar { width: 35%; height: 0.375rem; }
  .bar.wide { width: 60%; }
  .block { flex: 0 0 2.25rem; border-radius: 0.375rem; background: color-mix(in srgb, var(--brand-accent) 14%, transparent); }
  .block.tall { flex-basis: 3.25rem; }
  .row { height: 0.3125rem; width: 90%; }
  .row.short { width: 60%; }

  .generating .screen .bar,
  .generating .screen .block,
  .generating .screen .row {
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--foreground) 7%, transparent) 0%,
      color-mix(in srgb, var(--foreground) 15%, transparent) 50%,
      color-mix(in srgb, var(--foreground) 7%, transparent) 100%
    );
    background-size: 200% 100%;
    animation: shimmer 2.4s var(--motion-ease) infinite;
  }

  .generating .screen.mid .bar,
  .generating .screen.mid .block,
  .generating .screen.mid .row { animation-delay: 0.3s; }
  .generating .screen.front .bar,
  .generating .screen.front .block,
  .generating .screen.front .row { animation-delay: 0.6s; }

  .still .screen .bar,
  .still .screen .block,
  .still .screen .row { animation: none !important; }

  @keyframes shimmer {
    from { background-position: 100% 0; }
    to { background-position: -100% 0; }
  }

  .title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 500;
    letter-spacing: -0.02em;
    color: var(--foreground);
  }

  .hint {
    margin: -0.75rem 0 0;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--muted-foreground);
    text-wrap: balance;
  }

  @media (max-width: 640px) {
    .skeletons { width: 13rem; }
  }
</style>
