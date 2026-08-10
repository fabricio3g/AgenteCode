<script lang="ts">
  import { Search, X } from 'lucide-svelte';
  import { Input } from '$lib/components/ui';
  import { cn } from '$lib/utils/cn';

  let {
    value = $bindable(''),
    placeholder,
    label = 'Search models',
    clearLabel = 'Clear search',
    class: className = '',
  } = $props<{
    value?: string;
    placeholder: string;
    label?: string;
    clearLabel?: string;
    class?: string;
  }>();

  function clear() {
    value = '';
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !value) return;
    event.preventDefault();
    clear();
  }
</script>

<div class={cn('relative min-w-0', className)}>
  <Search
    class="pointer-events-none absolute left-3.5 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]"
    aria-hidden="true"
  />
  <Input
    variant="surface"
    class="h-11 rounded-lg pl-10 pr-10"
    bind:value
    {placeholder}
    aria-label={label}
    onkeydown={handleKeydown}
  />
  {#if value}
    <button
      type="button"
      class="absolute right-2 top-1/2 z-10 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-muted)] outline-none transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--text)] focus-visible:ring-[3px] focus-visible:ring-ring/25"
      aria-label={clearLabel}
      onclick={clear}
    >
      <X class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  {/if}
</div>
