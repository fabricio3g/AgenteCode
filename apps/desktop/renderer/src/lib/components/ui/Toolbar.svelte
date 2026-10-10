<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  let { as = 'div', wrap = true, density = 'default', ref = $bindable(), class: className = '', children, ...rest }: HTMLAttributes<HTMLElement> & { as?: 'div' | 'header' | 'footer'; wrap?: boolean; density?: 'default' | 'compact'; ref?: HTMLElement } = $props();
</script>
<svelte:element this={as} bind:this={ref} class={cn('ui-toolbar', wrap && 'is-wrap', density === 'compact' && 'is-compact', className)} {...rest}>
  {@render children?.()}
</svelte:element>
<style>
  .ui-toolbar { display:flex; flex-shrink:0; min-width:0; align-items:center; gap:0.5rem; color:var(--muted-foreground); font-size:var(--text-sm); }
  .is-wrap { flex-wrap:wrap; } .is-compact { --ui-icon-button-size:1.5rem; gap:0.25rem; font-size:var(--text-xs); }
</style>
