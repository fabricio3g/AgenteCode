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
    /** A roomier header and column (provider pages). */
    large?: boolean;
    children: Snippet;
  } = $props();
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
  <div class="min-h-0 flex-1 overflow-y-auto bg-background">
    <div class="mx-auto w-full px-5 pb-8 sm:px-8 space-y-5 sm:space-y-6 {wide ? 'max-w-[1120px]' : large ? 'max-w-[800px]' : 'max-w-[720px]'}">
      <!-- The page's own header sticks: the rail names the section, but a long
           page still has to say which one it is while you scroll it. It also
           carries the window's drag region, since Settings paints over the
           title bar that normally holds it. -->
      <header class="titlebar-drag sticky top-0 z-10 -mx-5 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-background px-5 {large ? 'py-3.5 sm:py-4' : 'py-3 sm:py-3.5'} sm:-mx-8 sm:px-8">
        <div class="flex min-w-0 items-center {large ? 'gap-4' : 'gap-3'}">
          {#if icon}
            <span class="flex shrink-0 items-center justify-center border border-border bg-card text-foreground {large ? 'size-12 rounded-2xl' : 'size-10 rounded-xl'}">
              {@render icon()}
            </span>
          {/if}
          <div class="min-w-0">
            <h3 class="truncate font-semibold tracking-[-0.02em] text-foreground {large ? 'text-xl' : 'text-lg'}">{title}</h3>
            {#if description}<p class="mt-0.5 text-muted-foreground {large ? 'text-[13.5px]' : 'text-[12.5px]'}">{description}</p>{/if}
          </div>
        </div>
        {#if actions}<div class="titlebar-no-drag flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
      </header>
      {@render children()}
    </div>
  </div>
</div>
