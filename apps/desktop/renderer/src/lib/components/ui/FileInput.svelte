<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  let { files = $bindable(), ref = $bindable(), class: className = '', ...rest }: Omit<HTMLInputAttributes, 'type'> & { ref?: HTMLInputElement } = $props();
</script>
<input type="file" bind:this={ref} bind:files class={cn('ui-file-input text-[length:var(--text-sm)] text-muted-foreground', className)} {...rest} />
<style>
  .ui-file-input { max-width:100%; }
  .ui-file-input::file-selector-button { margin-right:0.5rem; padding:0.4rem 0.65rem; border:0; border-radius:var(--radius-sm); background:var(--surface-hover); color:var(--foreground); font:inherit; cursor:pointer; }
  .ui-file-input:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
  .ui-file-input:disabled { opacity:0.5; }
</style>
