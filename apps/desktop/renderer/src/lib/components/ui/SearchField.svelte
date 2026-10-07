<svelte:options runes={true} />

<!--
  The library screens' search box: a rounded field with a leading search icon
  and a clear button once something is typed.
-->

<script lang="ts">
  import { Search, X } from 'lucide-svelte';

  let { value = $bindable(''), placeholder, clearLabel }: { value?: string; placeholder: string; clearLabel: string } = $props();
</script>

<div class="relative min-w-[14rem] flex-1">
  <Search class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
  <input
    class="h-10 w-full rounded-full border border-border bg-background pl-10 pr-9 text-sm text-foreground outline-none transition focus:border-[var(--border-hover)]"
    bind:value
    {placeholder}
    aria-label={placeholder}
  />
  {#if value}
    <button type="button" class="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--surface-hover)]" aria-label={clearLabel} onclick={() => (value = '')}><X class="size-3.5" /></button>
  {/if}
</div>
