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

<div class="ui-top-fade flex min-h-0 min-w-0 flex-1 flex-col">
  <div class="min-h-0 flex-1 overflow-y-auto bg-background">
    <div class="mx-auto w-full px-5 pb-10 sm:px-8 {large ? 'space-y-8 pt-9' : 'space-y-6 pt-7'} {wide ? 'max-w-[1120px]' : large ? 'max-w-[800px]' : 'max-w-[720px]'}">
      <header class="flex flex-wrap items-center justify-between gap-3">
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
        {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
      </header>
      {@render children()}
    </div>
  </div>
</div>
