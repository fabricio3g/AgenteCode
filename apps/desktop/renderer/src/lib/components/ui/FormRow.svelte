<svelte:options runes={true} />

<!--
  The settings screen's one row: a label and its description on the left, the
  control in one fixed column on the right, separated from the row above by the
  card's hairline.

  Every settings page used to declare its own version of this — eleven of them,
  with four paddings and three control widths, which is why controls never lined
  up from one page to the next. The page passes the control as children; the row
  owns the geometry.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils/cn';

  let {
    label,
    description,
    error,
    htmlFor,
    tile,
    align = 'center',
    layout = 'row',
    control = 'md',
    density = 'default',
    class: className = '',
    children
  }: {
    label: string;
    description?: string;
    error?: string;
    /** Set when the control is a labelable element: the row then owns the <label>. */
    htmlFor?: string;
    /** A 32px icon tile leading the row (runtime, provider and model lists). */
    tile?: Snippet;
    align?: 'center' | 'start';
    /** `stack` puts the control under the text at full width — a 7-step scale
        or a sample paragraph is wider than any control column. */
    layout?: 'row' | 'stack';
    /** `auto` for switches and segmented controls, `lg` for a wide field. */
    control?: 'auto' | 'md' | 'lg';
    density?: 'default' | 'compact';
    class?: string;
    children: Snippet;
  } = $props();

  const CONTROL: Record<'auto' | 'md' | 'lg', string> = {
    auto: '',
    md: 'sm:w-60',
    lg: 'sm:w-80'
  };
</script>

<div class={cn('settings-row', density === 'compact' && 'is-compact', align === 'start' && 'is-start', layout === 'stack' && 'is-stack', className)}>
  <div class="settings-row-text">
    {#if tile}<span class="settings-row-tile">{@render tile()}</span>{/if}
    <div class="min-w-0 space-y-0.5">
      <label class="settings-row-label" for={htmlFor}>{label}</label>
      {#if description}<p class="settings-row-description">{description}</p>{/if}
      {#if error}<p class="text-xs text-error" role="alert">{error}</p>{/if}
    </div>
  </div>
  <div class={cn('settings-row-control', layout === 'row' && CONTROL[control])}>
    {@render children()}
  </div>
</div>

<style>
  /* Stacked under sm:, one line above it. The card above supplies the hairline
     between rows, so the row itself draws no border. */
  .settings-row {
    display: flex;
    min-height: 3.25rem;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.875rem 0.125rem;
  }

  .settings-row.is-compact { min-height:0; padding:0; gap:0.5rem; }

  .settings-row-label {
    display: block;
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .settings-row-description {
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  @media (min-width: 640px) {
    .settings-row {
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 1.5rem;
    }
    .settings-row.is-start { align-items: flex-start; }
  }

  .settings-row-text {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.75rem;
  }

  .settings-row-control { flex-shrink: 0; }

  /* Stacked: the control runs the full width under the text, for scales and
     samples that no control column can hold. */
  @media (min-width: 640px) {
    .settings-row.is-stack { flex-direction: column; align-items: stretch; gap: 0.625rem; }
    .settings-row.is-stack .settings-row-control { width: 100%; }
  }

  .settings-row-tile {
    display: flex;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: var(--float-row-radius);
    background: var(--muted);
    color: var(--muted-foreground);
  }
</style>
