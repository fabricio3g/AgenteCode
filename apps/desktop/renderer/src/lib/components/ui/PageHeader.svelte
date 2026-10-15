<svelte:options runes={true} />

<!--
  The one page header for library screens (Artifacts, Files, Roleplay…): the
  title and one line saying what the page holds on the left, the page's
  actions hard right — at most one primary, the rest ghost.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils/cn';

  let { title, description = '', actions, class: className = '' }: {
    title: string;
    description?: string;
    actions?: Snippet;
    class?: string;
  } = $props();
</script>

<header class={cn('ui-page-header', className)}>
  <div class="ui-page-header-text">
    <h1>{title}</h1>
    {#if description}<p>{description}</p>{/if}
  </div>
  {#if actions}<div class="ui-page-header-actions">{@render actions()}</div>{/if}
</header>

<style>
  .ui-page-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.75rem 1rem;
  }
  .ui-page-header-text { min-width: 0; flex: 1; }
  h1 {
    margin: 0;
    color: var(--foreground);
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
  p {
    margin: 0.25rem 0 0;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
  }
  .ui-page-header-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
  }
</style>
