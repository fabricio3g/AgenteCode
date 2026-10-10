<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  let { value = $bindable(), ref = $bindable(), class: className = '', ...rest }: Omit<HTMLInputAttributes, 'type'> & { ref?: HTMLInputElement } = $props();
</script>
<input type="color" bind:this={ref} bind:value class={cn('ui-color-input', className)} {...rest} />
<style>
  .ui-color-input { width:1.5rem; height:1.5rem; padding:0; border:0; border-radius:var(--radius-sm); background:transparent; cursor:pointer; }
  .ui-color-input:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
  .ui-color-input:disabled { opacity:0.5; cursor:not-allowed; }
</style>
