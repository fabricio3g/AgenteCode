<svelte:options runes={true} />

<!--
  The frame every settings page shares: a scrolling column with one title,
  one line of description and optional header actions, then the sections.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    description,
    icon,
    actions,
    wide = false,
    children
  }: {
    title: string;
    description?: string;
    /** Leading mark next to the title (a provider logo, for example). */
    icon?: Snippet;
    actions?: Snippet;
    /** Room for a side panel (the model details next to the results). */
    wide?: boolean;
    children: Snippet;
  } = $props();
</script>

<div class="min-h-0 flex-1 overflow-y-auto bg-background">
  <div class="mx-auto w-full space-y-6 px-5 pb-10 pt-7 sm:px-8 {wide ? 'max-w-[1120px]' : 'max-w-[720px]'}">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-3">
        {#if icon}
          <span class="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground">
            {@render icon()}
          </span>
        {/if}
        <div class="min-w-0">
          <h3 class="truncate text-lg font-semibold tracking-[-0.02em] text-foreground">{title}</h3>
          {#if description}<p class="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>{/if}
        </div>
      </div>
      {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
    </header>
    {@render children()}
  </div>
</div>
