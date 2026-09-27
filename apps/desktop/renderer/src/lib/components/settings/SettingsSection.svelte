<svelte:options runes={true} />

<!--
  One group of related settings: a title and actions above, then a card of
  rows separated by hairlines, so a section reads as a single list.
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
    class?: string;
    children: Snippet;
  } = $props();
</script>

<section class={cn('settings-section', className)}>
  {#if title || actions}
    <div class="flex items-end justify-between gap-3 px-1 pb-2">
      <div class="min-w-0">
        {#if title}<h4 class="text-[13px] font-semibold text-foreground">{title}</h4>{/if}
        {#if description}<p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>{/if}
      </div>
      {#if actions}<div class="flex shrink-0 items-center gap-1">{@render actions()}</div>{/if}
    </div>
  {/if}
  <div class={cn('settings-card', tone === 'danger' && 'is-danger', flush ? 'py-1' : 'px-4 py-1')}>
    <div class="settings-rows">
      {@render children()}
    </div>
  </div>
</section>

<style>
  /* A grouped list: a quiet white card with a hairline edge, rows inside
     separated by hairlines — the same card language as the chat. */
  .settings-card {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    background: var(--card);
  }

  .settings-card.is-danger {
    border-color: var(--error-border);
    background: color-mix(in srgb, var(--error-bg) 40%, var(--card));
  }

  /* Direct children are rows; a hairline separates each from the next. */
  .settings-rows > :global(* + *) {
    border-top: 1px solid var(--border-subtle);
  }
</style>
