<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { Search, X } from 'lucide-svelte';
  import Input from './Input.svelte';
  import IconButton from './IconButton.svelte';
  import { cn } from '$lib/utils/cn';
  let { value = $bindable(''), ref = $bindable(), placeholder, clearLabel, class: className = '', variant = 'default', ...rest }: Omit<HTMLInputAttributes, 'value'> & { value?: string; ref?: HTMLInputElement; placeholder: string; clearLabel: string; variant?: 'default' | 'surface' | 'inline' } = $props();
</script>
<div class={cn('relative min-w-0 flex-1', className)}>
  <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
  <Input type="search" bind:value bind:ref {placeholder} {variant} aria-label={placeholder} class="pl-8 pr-8 [&::-webkit-search-cancel-button]:appearance-none" {...rest} />
  {#if value}<div class="absolute right-1 top-1/2 -translate-y-1/2"><IconButton label={clearLabel} size="xs" onclick={() => { value = ''; ref?.focus(); }}><X /></IconButton></div>{/if}
</div>
