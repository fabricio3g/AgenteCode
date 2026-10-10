<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import Button from './Button.svelte';
  import { cn } from '$lib/utils/cn';
  let { title, description, illustration, action, onaction, children, class: className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { title?: string; description?: string; illustration?: Snippet; action?: string; onaction?: () => void } = $props();
</script>
<div class={cn('ui-empty-state', className)} {...rest}>
  {#if illustration}<div class="illustration" aria-hidden="true">{@render illustration()}</div>{/if}
  {#if title}<p class="title">{title}</p>{/if}
  {#if description}<p class="description">{description}</p>{/if}
  {#if action && onaction}<Button variant="outline" size="sm" onclick={onaction}>{action}</Button>{/if}
  {@render children?.()}
</div>
<style>
  .ui-empty-state { display:flex; flex:1; min-width:0; flex-direction:column; justify-content:center; align-items:center; gap:0.5rem; padding:2rem 1rem; color:var(--muted-foreground); text-align:center; font-size:var(--text-sm); }
  .title { font-size:var(--text-base); font-weight:500; color:var(--foreground); }
  .description { max-width:32rem; line-height:1.5; text-wrap:balance; }
  .illustration { margin-bottom:0.75rem; }
</style>
