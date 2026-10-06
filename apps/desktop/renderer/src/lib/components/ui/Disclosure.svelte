<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronDown, ChevronRight } from 'lucide-svelte';
  import { cn } from '$lib/utils/cn';
  import { motionSlide } from '$lib/utils/transitions';

  let {
    open = $bindable(false),
    title,
    description,
    disabled = false,
    quiet = false,
    class: className = '',
    children,
  }: {
    open?: boolean;
    title: string;
    description?: string;
    disabled?: boolean;
    /** Text only: a chevron and the title, no card around it. */
    quiet?: boolean;
    class?: string;
    children: Snippet;
  } = $props();
</script>

{#if quiet}
  <div class={className}>
    <button
      type="button"
      class="group flex w-full items-center gap-1.5 py-1.5 text-left text-[12.5px] text-muted-foreground outline-none transition-colors duration-[var(--motion-fast)] hover:text-foreground focus-visible:text-foreground disabled:opacity-50"
      aria-expanded={open}
      {disabled}
      onclick={() => (open = !open)}
    >
      <ChevronRight class={cn('size-3.5 shrink-0 transition-transform duration-[var(--motion-normal)] ease-[var(--motion-ease)]', open && 'rotate-90')} />
      <span class="font-medium text-foreground">{title}</span>
      {#if description}<span class="min-w-0 truncate">{description}</span>{/if}
    </button>
    {#if open}
      <div class="pb-1 pl-5 pt-2" transition:motionSlide={{ duration: 180 }}>
        {@render children()}
      </div>
    {/if}
  </div>
{:else}
<div class={cn('overflow-hidden rounded-[var(--float-radius)] border border-[var(--float-border)] bg-[var(--card)]', className)}>
  <button
    type="button"
    class="flex w-full items-center justify-between gap-4 px-4 py-3 text-left outline-none transition-colors duration-[var(--motion-fast)] hover:bg-[var(--float-row-hover)] focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/20 disabled:opacity-50"
    aria-expanded={open}
    {disabled}
    onclick={() => (open = !open)}
  >
    <span class="min-w-0">
      <span class="block text-[13px] font-medium text-foreground">{title}</span>
      {#if description}<span class="mt-0.5 block text-xs text-muted-foreground">{description}</span>{/if}
    </span>
    <ChevronDown class={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-normal)] ease-[var(--motion-ease)]', open && 'rotate-180')} />
  </button>
  {#if open}
    <div class="border-t border-[var(--border-subtle)] px-4 py-3" transition:motionSlide={{ duration: 180 }}>
      {@render children()}
    </div>
  {/if}
</div>
{/if}
