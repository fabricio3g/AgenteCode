<svelte:options runes={true} />

<script lang="ts">
  import { fly } from 'svelte/transition';

  let { children, label, position = 'right' }: { children?: any; label: string; position?: 'left' | 'right' } = $props();
  let visible = $state(false);
</script>

<div
  class="tooltip-wrapper relative"
  role="presentation"
  onmouseenter={() => (visible = true)}
  onmouseleave={() => (visible = false)}
>
  {@render children?.()}
  {#if visible}
    <div
      class="tooltip-pill absolute top-1/2 z-50 -translate-y-1/2 whitespace-nowrap px-2 py-1 text-xs {position === 'left' ? 'right-full' : 'left-full'}"
      style={position === 'left' ? 'margin-right: 8px;' : 'margin-left: 8px;'}
      transition:fly={{ x: position === 'left' ? 4 : -4, duration: 100 }}
    >
      {label}
    </div>
  {/if}
</div>

<style>
  .tooltip-pill {
    background: var(--surface-overlay);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--radius-full);
    box-shadow: var(--shadow-md);
    pointer-events: none;
  }
</style>
