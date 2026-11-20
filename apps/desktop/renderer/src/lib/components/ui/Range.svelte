<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  let { value = $bindable(), ref = $bindable(), class: className = '', ...rest }: Omit<HTMLInputAttributes, 'type'> & { ref?: HTMLInputElement } = $props();
</script>
<input type="range" bind:this={ref} bind:value class={cn('ui-range', className)} {...rest} />
<style>
  .ui-range { -webkit-appearance:none; appearance:none; width:100%; min-width:0; height:0.25rem; margin:0.625rem 0; border-radius:var(--radius-full); background:var(--border-hover); cursor:pointer; }
  .ui-range::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:0.875rem; height:0.875rem; border-radius:0.3125rem; background:var(--foreground); box-shadow:var(--control-shadow-primary); transition:transform var(--motion-instant) var(--motion-ease-out); }
  .ui-range:hover:not(:disabled)::-webkit-slider-thumb { transform:scale(1.06); }
  .ui-range:active:not(:disabled)::-webkit-slider-thumb { transform:scale(0.96); }
  .ui-range:focus-visible { outline:2px solid var(--brand-accent); outline-offset:4px; border-radius:var(--radius-full); }
  .ui-range:disabled { opacity:0.5; cursor:not-allowed; }
</style>
