<svelte:options runes={true} />

<!--
  Interactive cause-and-effect timeline for history, literature, economics,
  or roadmaps: click any era to see what triggered it and what it unlocked.
-->

<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';

  export interface TimelineEra {
    year: string;
    title: string;
    trigger: string;
    unlocked: string;
  }

  interface Props {
    eras: TimelineEra[];
  }

  let { eras }: Props = $props();
  let index = $state(0);

  $effect(() => {
    if (index >= eras.length) index = 0;
  });

  const current = $derived(eras[index]);
</script>

<div class="tl">
  <div class="tl-bar">
    {#each eras as era, i (i)}
      <Button variant="plain" class={`tl-tab${i === index ? ' is-on' : ''}`} onclick={() => (index = i)}>
        <span class="tl-yr">{era.year}</span>
        <span class="tl-nm">{era.title}</span>
      </Button>
    {/each}
  </div>

  {#if current}
    <div class="tl-card">
      <p class="tl-line"><strong>Trigger:</strong> {current.trigger}</p>
      <p class="tl-line is-hi"><strong>Unlocked:</strong> {current.unlocked}</p>
    </div>
  {/if}
</div>

<style>
  .tl { display: flex; flex-direction: column; gap: 0.625rem; }
  .tl-bar { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 0.3rem; }
  .tl :global(.tl-tab) {
    display: flex; flex-direction: column; align-items: flex-start; gap: 0.1rem;
    padding: 0.5rem 0.6rem; border-radius: var(--radius-md);
    border: 1px solid transparent; background: color-mix(in srgb, var(--foreground) 3%, transparent);
    text-align: left; cursor: pointer;
  }
  .tl :global(.tl-tab.is-on) { border-color: var(--brand-accent, var(--border)); background: var(--surface-hover); }
  .tl-yr { font-family: var(--font-mono); font-size: 11px; color: var(--brand-accent, var(--muted-foreground)); font-weight: 600; }
  .tl-nm { font-size: var(--text-xs); font-weight: 500; color: var(--foreground); }
  .tl-card {
    display: flex; flex-direction: column; gap: 0.35rem;
    padding: 0.75rem; border-radius: var(--radius-md); background: color-mix(in srgb, var(--foreground) 3%, transparent);
  }
  .tl-line { margin: 0; font-size: var(--text-xs); color: var(--text-secondary); line-height: 1.55; }
  .tl-line.is-hi { color: var(--foreground); }
</style>
