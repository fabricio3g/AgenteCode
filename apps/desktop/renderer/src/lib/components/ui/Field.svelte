<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils/cn';

  let {
    label,
    description,
    error,
    htmlFor,
    horizontal = false,
    class: className = '',
    children,
  }: {
    label: string;
    description?: string;
    error?: string;
    htmlFor?: string;
    horizontal?: boolean;
    class?: string;
    children: Snippet;
  } = $props();
</script>

<div class={cn(horizontal && 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between', className)}>
  <div class="min-w-0 space-y-1">
    <label class="block text-sm font-medium text-foreground" for={htmlFor}>{label}</label>
    {#if description}
      <p class="text-xs leading-relaxed text-muted-foreground">{description}</p>
    {/if}
    {#if error}
      <p class="text-xs text-error" role="alert">{error}</p>
    {/if}
  </div>
  <div class={cn(horizontal && 'shrink-0 sm:w-72')}>
    {@render children()}
  </div>
</div>
