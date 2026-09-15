<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';
  import { cn } from '$lib/utils/cn';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import Button from './Button.svelte';

  let {
    title,
    description,
    labelledBy = 'dialog-title',
    onclose,
    class: className = '',
    children,
    headerActions,
  }: {
    title: string;
    description?: string;
    labelledBy?: string;
    onclose: () => void;
    class?: string;
    children: Snippet;
    headerActions?: Snippet;
  } = $props();

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onclose();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  class="fixed inset-0 z-[63] flex items-center justify-center overflow-hidden bg-[var(--overlay)] p-4 backdrop-blur-[4px]"
  role="presentation"
  onclick={onclose}
  transition:motionFade={{ duration: 220 }}
>
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby={labelledBy}
    tabindex="-1"
    class={cn(
      'relative flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-[var(--radius-2xl)] bg-popover text-foreground shadow-[shadow:var(--shadow-xl)]',
      className
    )}
    onclick={(event) => event.stopPropagation()}
    transition:flyAndScale={{ y: 8, start: 0.98, duration: 240 }}
  >
    <header class="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 sm:px-5">
      <div class="min-w-0">
        <h2 id={labelledBy} class="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
        {#if description}<p class="truncate text-xs text-muted-foreground">{description}</p>{/if}
      </div>
      <div class="flex items-center gap-1">
        {@render headerActions?.()}
        <Button variant="ghost" size="icon-sm" aria-label="Close" onclick={onclose}>
          <X />
        </Button>
      </div>
    </header>
    {@render children()}
  </div>
</div>
