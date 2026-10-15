<!--
  The one empty state. Panes and pages centre it (nothing in it is meant to be
  scanned); lists and pickers pass `align="start"` so it keeps the list's left
  edge. `size="compact"` is the sidebar/picker scale, `icon` a quiet glyph tile.
-->
<script lang="ts">
  import type { ComponentType, Snippet } from 'svelte';
  import type { Icon as LucideIcon } from 'lucide-svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import Button from './Button.svelte';
  import { cn } from '$lib/utils/cn';
  let {
    title,
    description,
    icon: Icon,
    illustration,
    action,
    onaction,
    align = 'center',
    size = 'default',
    children,
    class: className = '',
    ...rest
  }: HTMLAttributes<HTMLDivElement> & {
    title?: string;
    description?: string;
    icon?: ComponentType<LucideIcon>;
    illustration?: Snippet;
    action?: string;
    onaction?: () => void;
    align?: 'center' | 'start';
    size?: 'default' | 'compact';
  } = $props();
</script>
<div class={cn('ui-empty-state', className)} data-align={align} data-size={size} {...rest}>
  {#if illustration}<div class="illustration" aria-hidden="true">{@render illustration()}</div>
  {:else if Icon}<div class="icon" aria-hidden="true"><Icon /></div>{/if}
  {#if title}<p class="title">{title}</p>{/if}
  {#if description}<p class="description">{description}</p>{/if}
  {#if action && onaction}<Button variant="outline" size="sm" onclick={onaction}>{action}</Button>{/if}
  {@render children?.()}
</div>
<style>
  .ui-empty-state { display:flex; flex:1; min-width:0; flex-direction:column; justify-content:center; align-items:center; gap:0.5rem; padding:2rem 1rem; color:var(--muted-foreground); text-align:center; font-size:var(--text-sm); }
  .ui-empty-state[data-align='start'] { flex:0 0 auto; align-items:flex-start; text-align:start; }
  .ui-empty-state[data-size='compact'] { gap:0.375rem; padding:1.5rem 0.625rem; font-size:var(--text-xs); }
  .title { font-size:var(--text-base); font-weight:500; color:var(--foreground); }
  [data-size='compact'] .title { font-size:var(--text-sm); }
  .description { max-width:32rem; line-height:1.5; text-wrap:balance; }
  [data-size='compact'] .description { max-width:24rem; }
  .illustration { margin-bottom:0.75rem; }
  .icon { display:flex; width:2rem; height:2rem; align-items:center; justify-content:center; border-radius:var(--radius-md); background:var(--surface-hover); color:var(--muted-foreground); }
  .icon :global(svg) { width:1rem; height:1rem; }
</style>
