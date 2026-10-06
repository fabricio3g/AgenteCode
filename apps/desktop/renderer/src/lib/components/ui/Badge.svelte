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

  // Quiet on purpose: a hairline and tinted text, never a filled chip. A
  // settings page can carry a dozen of these; filled green and red ones
  // turned it into a traffic light.
  const tones = {
    neutral: 'border-[var(--border)] text-muted-foreground',
    success: 'border-[var(--border)] text-success',
    warning: 'border-warning-border text-warning',
    error: 'border-error-border text-error',
  };
</script>

<span
  class={cn('inline-flex items-center gap-1 rounded-full border bg-transparent px-2 py-0.5 text-[12px] font-medium leading-4', tones[tone], className)}
  {...rest}
>
  {@render children?.()}
</span>
