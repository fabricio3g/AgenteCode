<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  let { separated = false, class: className = '', children, ...rest }: HTMLAttributes<HTMLElement> & { separated?: boolean } = $props();
</script>
<footer class={cn('ui-dialog-footer', separated && 'is-separated', className)} {...rest}>
  {@render children?.()}
</footer>
<style>
  .ui-dialog-footer { display:flex; flex-shrink:0; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:0.5rem; padding:0.5rem 1.25rem 1.125rem; }
  .is-separated { border-top:1px solid var(--border-subtle); padding-block:0.75rem; }
</style>
