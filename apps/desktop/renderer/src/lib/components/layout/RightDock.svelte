<svelte:options runes={true} />

<!--
  The right dock: every open side panel in one column, each in its own
  rounded, bordered box. More than one open stack top to bottom with a drag
  bar between them; the dock's left edge sets its width.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ResizeHandle } from '$lib/components/ui';
  import { rightDock, shiftWeights } from '$lib/stores/right-dock.svelte';
  import { cn } from '$lib/utils/cn';

  export interface DockPanel {
    id: string;
    content: Snippet;
    /** A stronger border (the browser while the agent drives it). */
    accent?: boolean;
  }

  let { panels }: { panels: DockPanel[] } = $props();

  let column = $state<HTMLDivElement>();
  let startWidth = 0;
  let startWeights: [number, number] = [1, 1];

  function resizeWidth(delta: number) {
    rightDock.setWidth(startWidth - delta);
  }

  function startSplit(index: number) {
    startWeights = [rightDock.weight(panels[index].id), rightDock.weight(panels[index + 1].id)];
  }

  function resizeSplit(index: number, delta: number) {
    const total = panels.reduce((sum, panel) => sum + rightDock.weight(panel.id), 0);
    const height = column?.clientHeight || 1;
    const [a, b] = shiftWeights(startWeights[0], startWeights[1], (delta / height) * total);
    rightDock.setWeights({ [panels[index].id]: a, [panels[index + 1].id]: b });
  }
</script>

{#if panels.length}
  <ResizeHandle axis="x" label={$t('dock.resizeWidth')} onstart={() => (startWidth = rightDock.layout.width)} onresize={resizeWidth} />
  <div bind:this={column} class="dock" style:width={`${rightDock.layout.width}px`}>
    {#each panels as panel, index (panel.id)}
      {#if index > 0}
        <ResizeHandle axis="y" label={$t('dock.resizeSplit')} onstart={() => startSplit(index - 1)} onresize={(delta) => resizeSplit(index - 1, delta)} />
      {/if}
      <section class={cn('dock-card', panel.accent && 'accent')} style:flex-grow={rightDock.weight(panel.id)}>
        {@render panel.content()}
      </section>
    {/each}
  </div>
{/if}

<style>
  .dock {
    display: flex;
    min-width: 320px;
    /* The conversation always keeps a readable column. */
    max-width: calc(100% - 22rem);
    flex-shrink: 0;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem 0.5rem 0.5rem 0;
  }
  .dock-card {
    display: flex;
    min-height: 8rem;
    flex-basis: 0;
    flex-direction: column;
    overflow: hidden;
    border-radius: 0.875rem;
    border: 1px solid var(--border-hover);
    background: var(--card);
    box-shadow: var(--panel-shadow);
    transition: border-color var(--motion-fast) var(--motion-ease);
  }
  .dock-card.accent {
    border-color: var(--brand-accent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand-accent) 35%, transparent), var(--panel-shadow);
  }
</style>
