<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronDown } from 'lucide-svelte';
  import { cn } from '$lib/utils/cn';
  import { motionSlide } from '$lib/utils/transitions';

  let {
    open = $bindable(false),
    title,
    description,
    disabled = false,
    class: className = '',
    children,
  }: {
    open?: boolean;
    title: string;
    description?: string;
    disabled?: boolean;
    class?: string;
    children: Snippet;
  } = $props();
</script>

<div class={cn('overflow-hidden rounded-lg border border-border bg-background', className)}>
  <button
    type="button"
    class="flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left outline-none transition-colors duration-[var(--motion-fast)] hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/20 disabled:opacity-50"
    aria-expanded={open}
    {disabled}
    onclick={() => (open = !open)}
  >
    <span class="min-w-0">
      <span class="block text-sm font-medium text-foreground">{title}</span>
      {#if description}<span class="mt-0.5 block text-xs text-muted-foreground">{description}</span>{/if}
    </span>
    <ChevronDown class={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-normal)] ease-[var(--motion-ease)]', open && 'rotate-180')} />
  </button>
  {#if open}
    <div class="border-t border-border px-3 py-3" transition:motionSlide={{ duration: 180 }}>
      {@render children()}
    </div>
  {/if}
</div>
