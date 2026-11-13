<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

  import { Search, X } from '$lib/icons';
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
    class="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]"
    aria-hidden="true"
  />
  <Input
    class="h-8 pl-9 pr-9 text-[length:var(--text-sm)]"
    bind:value
    {placeholder}
    aria-label={label}
    onkeydown={handleKeydown}
  />
  {#if value}
    <IconButton label={clearLabel} size="xs" variant="ghost"
      type="button"
      class={uiClass("absolute right-1 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[var(--float-row-radius)] text-[var(--text-muted)] outline-none transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--text)] focus-visible:ring-[3px] focus-visible:ring-ring/25")}

      onclick={clear}
    >
      <X class="h-3.5 w-3.5" aria-hidden="true" />
    </IconButton>
  {/if}
</div>
