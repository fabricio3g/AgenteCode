<svelte:options runes={true} />

<script lang="ts">
  import { fly } from 'svelte/transition';

  let { children, label }: { children?: any; label: string } = $props();
  let visible = $state(false);
</script>

<div
  class="tooltip-wrapper relative"
  onmouseenter={() => (visible = true)}
  onmouseleave={() => (visible = false)}
>
  {@render children?.()}
  {#if visible}
    <div
      class="tooltip-pill absolute left-full top-1/2 z-50 -translate-y-1/2 whitespace-nowrap px-2 py-1 text-xs"
      transition:fly={{ x: -4, duration: 100 }}
    >
      {label}
    </div>
  {/if}
</div>

<style>
  .tooltip-pill {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--radius-full);
    box-shadow: var(--shadow-m);
    margin-left: 8px;
    pointer-events: none;
  }
</style>
