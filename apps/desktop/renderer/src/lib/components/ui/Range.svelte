<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  let { value = $bindable(), ref = $bindable(), class: className = '', ...rest }: Omit<HTMLInputAttributes, 'type'> & { ref?: HTMLInputElement } = $props();
</script>
<input type="range" bind:this={ref} bind:value class={cn('ui-range', className)} {...rest} />
<style>
  .ui-range { width:100%; min-width:0; height:1.5rem; accent-color:var(--muted-foreground); cursor:pointer; }
  .ui-range:focus-visible { outline:2px solid var(--ring); outline-offset:2px; border-radius:var(--radius-sm); }
  .ui-range:disabled { opacity:0.5; cursor:not-allowed; }
</style>
