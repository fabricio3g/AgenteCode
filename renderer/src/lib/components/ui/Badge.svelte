<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';

  let {
    tone = 'neutral',
    class: className = '',
    children,
    ...rest
  }: HTMLAttributes<HTMLSpanElement> & {
    tone?: 'neutral' | 'success' | 'warning' | 'error';
    class?: string;
  } = $props();

  const tones = {
    neutral: 'border-border bg-muted/50 text-muted-foreground',
    success: 'border-success-border bg-success-bg text-success',
    warning: 'border-warning-border bg-warning-bg text-warning',
    error: 'border-error-border bg-error-bg text-error',
  };
</script>

<span
  class={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-4', tones[tone], className)}
  {...rest}
>
  {@render children?.()}
</span>
