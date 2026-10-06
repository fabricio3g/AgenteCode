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
  <div class={cn('settings-card', tone === 'danger' && 'is-danger', flush && 'py-1')}>
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
    padding: 0 0.25rem 0.5rem;
  }

  .settings-section-title {
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .settings-section-description {
    margin-top: 0.125rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  /* SettingsRow owns the inset, so a hairline runs the full card width and two
     pages cannot disagree about the gutter. `flush` adds the small vertical
     padding custom content (tile grids) still needs. */
  .settings-card {
    overflow: hidden;
    border: 1px solid var(--float-border);
    border-radius: var(--float-radius);
    background: var(--card);
  }

  .settings-card.is-danger {
    border-color: var(--error-border);
  }

  /* Direct children are rows; a hairline separates each from the next. */
  .settings-rows > :global(* + *) {
    border-top: 1px solid var(--border-subtle);
  }
</style>
