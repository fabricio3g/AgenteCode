<svelte:options runes={true} />

<!--
  The one header for a pane or dock panel: identity hard left (an optional
  leading control, icon, title and a dim subtitle — or `children` when the
  pane needs its own content there), the pane's actions hard right. Borderless,
  one height, type from the ladder; extra attributes (aria, data-*, handlers)
  land on the <header>.
-->

<script lang="ts">
  import type { ComponentType, Snippet } from 'svelte';
  import type { Icon as LucideIcon } from 'lucide-svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';

  let {
    title = '',
    subtitle = '',
    titleAttr,
    icon: Icon,
    leading,
    children,
    actions,
    class: className = '',
    ...rest
  }: Omit<HTMLAttributes<HTMLElement>, 'title' | 'children'> & {
    title?: string;
    subtitle?: string;
    /** Native tooltip for the title text. */
    titleAttr?: string;
    icon?: ComponentType<LucideIcon>;
    /** Before the icon: a back button, a drag grip. */
    leading?: Snippet;
    /** Replaces the title/subtitle block. */
    children?: Snippet;
    actions?: Snippet;
    class?: string;
  } = $props();
</script>

<header class={cn('ui-pane-header', className)} {...rest}>
  {#if leading}{@render leading()}{/if}
  {#if Icon}<span class="ui-pane-header-icon" aria-hidden="true"><Icon class="size-3.5" /></span>{/if}
  {#if children}
    <div class="ui-pane-header-main">{@render children()}</div>
  {:else}
    <div class="ui-pane-header-main">
      <p class="ui-pane-header-title" title={titleAttr ?? (title || undefined)}>{title}</p>
      {#if subtitle}<p class="ui-pane-header-subtitle">{subtitle}</p>{/if}
    </div>
  {/if}
  {#if actions}<div class="ui-pane-header-actions">{@render actions()}</div>{/if}
</header>

<style>
  .ui-pane-header {
    display: flex;
    height: 2.25rem;
    min-width: 0;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.3rem 0 0.75rem;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
  }
  .ui-pane-header-icon { display: inline-flex; flex-shrink: 0; }
  .ui-pane-header-main {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: baseline;
    gap: 0.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ui-pane-header-title {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--foreground);
    font-weight: 500;
  }
  .ui-pane-header-subtitle {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--text-xs);
  }
  .ui-pane-header-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.125rem;
  }
</style>
