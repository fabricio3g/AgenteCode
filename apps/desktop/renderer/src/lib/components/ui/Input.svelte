<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';

  type Props = HTMLInputAttributes & {
    class?: string;
    variant?: 'default' | 'surface';
  };

  let {
    class: className = '',
    variant = 'default',
    value = $bindable(),
    ...rest
  }: Props = $props();
</script>

<input
  bind:value
  class={cn(
    'h-8 w-full rounded-[var(--float-row-radius)] px-2.5 text-[length:var(--text-sm)] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
    variant === 'surface'
      ? 'border-0 bg-[var(--card)] transition-[background-color,box-shadow] duration-[var(--motion-fast)] hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--card)] focus-visible:ring-[3px] focus-visible:ring-ring/25'
      : 'border border-[var(--float-border)] bg-background transition-[border-color,box-shadow] duration-[var(--motion-fast)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20',
    className
  )}
  {...rest}
/>
