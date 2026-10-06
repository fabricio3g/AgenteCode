<svelte:options runes={true} />

<!--
  The frame every settings page shares: one scrolling column, a title with one
  line of description and optional actions, then the sections.

  The header scrolls with the page. It used to stick with a hairline under it,
  which cut the column off at a different width than the cards below and left
  half a card showing under the bar; the rail already names the page.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    description,
    icon,
    actions,
    wide = false,
    large = false,
    children
  }: {
    title: string;
    description?: string;
    /** Leading mark next to the title (a provider logo, for example). */
    icon?: Snippet;
    actions?: Snippet;
    /** Room for a side panel (the model details next to the results). */
    wide?: boolean;
    /** A roomier column (provider pages). */
    large?: boolean;
    children: Snippet;
  } = $props();
</script>

<div class="settings-page">
  <div class="settings-column" class:is-wide={wide} class:is-large={large}>
    <header class="settings-page-header">
      <div class="flex min-w-0 items-center gap-3">
        {#if icon}<span class="settings-page-icon">{@render icon()}</span>{/if}
        <div class="min-w-0">
          <h3 class="settings-page-title">{title}</h3>
          {#if description}<p class="settings-page-description">{description}</p>{/if}
        </div>
      </div>
      {#if actions}<div class="flex shrink-0 flex-wrap items-center gap-2">{@render actions()}</div>{/if}
    </header>
    {@render children()}
  </div>
</div>

<style>
  .settings-page {
    min-height: 0;
    min-width: 0;
    flex: 1;
    overflow-y: auto;
    background: var(--background);
  }

  .settings-column {
    display: flex;
    width: 100%;
    max-width: 44rem;
    flex-direction: column;
    gap: 1.75rem;
    margin-inline: auto;
    padding: 1.75rem 1.25rem 3rem;
  }

  .settings-column.is-large { max-width: 50rem; }
  .settings-column.is-wide { max-width: 70rem; }

  @media (min-width: 640px) {
    .settings-column { padding-inline: 2rem; }
  }

  .settings-page-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem 1rem;
  }

  .settings-page-icon {
    display: flex;
    width: 2.5rem;
    height: 2.5rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--float-border);
    border-radius: var(--float-radius);
    background: var(--card);
    color: var(--foreground);
  }

  .settings-page-title {
    color: var(--foreground);
    font-size: calc(18px * var(--reading-scale));
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.3;
  }

  .settings-page-description {
    margin-top: 0.125rem;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
    line-height: 1.5;
  }
</style>
