<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Button from './Button.svelte';
  import { cn } from '$lib/utils/cn';
  let { selected = false, ref = $bindable(), class: className = '', children, ...rest }: HTMLButtonAttributes & { selected?: boolean; ref?: HTMLButtonElement } = $props();
</script>
<Button variant="plain" bind:ref class={cn('ui-list-row', selected && 'is-selected', className)} {...rest}>
  {@render children?.()}
</Button>
<style>
  :global(.ui-list-row) { display:flex; width:100%; min-width:0; align-items:center; gap:0.5rem; padding:0.5rem 0.625rem; text-align:left; font-size:var(--text-sm); color:var(--muted-foreground); }
  :global(.ui-list-row:hover), :global(.ui-list-row.is-selected) { background:var(--float-row-hover); color:var(--foreground); }
</style>
