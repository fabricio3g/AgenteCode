<svelte:options runes={true} />

<!--
  One group of related settings: a title (and actions) above, then a card of
  rows separated by hairlines, so a section reads as a single list.

  The card is the app's floating-surface edge (`--float-border`, `--float-radius`)
  on the card fill, so a settings group and a menu are drawn by one hand.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils/cn';

  let {
    title,
    description,
    actions,
    tone = 'default',
    flush = false,
    class: className = '',
    children
  }: {
    title?: string;
    description?: string;
    actions?: Snippet;
    tone?: 'default' | 'danger';
    /** Content spans the card edge to edge (lists with their own padding). */
    flush?: boolean;
    /** Kept for callers; every section now shares one title size. */
    large?: boolean;
    class?: string;
    children: Snippet;
  } = $props();
</script>

<section class={cn('settings-section', className)}>
  {#if title || actions}
    <div class="settings-section-head">
      <div class="min-w-0">
        {#if title}<h4 class="settings-section-title">{title}</h4>{/if}
        {#if description}<p class="settings-section-description">{description}</p>{/if}
      </div>
      {#if actions}<div class="flex shrink-0 items-center gap-1.5">{@render actions()}</div>{/if}
    </div>
  {/if}
  <div class={cn('settings-card', tone === 'danger' && 'is-danger', flush && 'is-flush py-1')}>
    <div class="settings-rows">
      {@render children()}
    </div>
  </div>
</section>

<style>
  .settings-section-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0 0.125rem 0.625rem;
  }

  .settings-section-title {
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .settings-section-description {
    margin-top: 0.125rem;
    max-width: 60ch;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    line-height: 1.55;
  }

  /* Law of Common Region by tint alone: a group is a soft fill, not a ring
     with a shadow and a crown. The column edge and the space between groups
     already separate them, so a border would be an edge on an edge. */
  .settings-card {
    position: relative;
    overflow: visible;
    border-radius: var(--float-radius);
    background: color-mix(in srgb, var(--foreground) 4%, transparent);
    padding-inline: 1.125rem;
  }
  .settings-card.is-flush {
    padding-inline: 0;
  }
  .settings-rows > :global(* + *) {
    border-top: 1px solid color-mix(in srgb, var(--foreground) 7%, transparent);
  }

  .settings-card.is-danger {
    background: var(--error-bg);
  }

</style>
