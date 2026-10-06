<svelte:options runes={true} />

<!--
  Square icon-only button with a required accessible label.

  Consolidates four competing idioms: `.ui-icon-button`, `.ui-legacy-icon-button`,
  the scoped `.msg-action-btn` in the message action bar, and raw
  `<Button variant="ghost" size="icon-sm">`. The `label` prop is not optional —
  every one of those idioms had sites with no accessible name.
-->

<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils/cn';
  import { buttonVariants, type ButtonVariant } from './button/variants';

  type Props = Omit<HTMLButtonAttributes, 'aria-label' | 'title'> & {
    /** Accessible name. Also used as the native tooltip unless `title` is set. */
    label: string;
    /** Override the native tooltip; defaults to `label`. Pass '' to suppress. */
    title?: string;
    variant?: ButtonVariant;
    size?: 'xs' | 'sm' | 'md' | 'lg';
    /** Subtle variant used by message hover bars: transparent until hovered. */
    quiet?: boolean;
    class?: string;
    children?: Snippet;
  };

  let {
    label,
    title,
    variant = 'ghost',
    size = 'sm',
    quiet = false,
    class: className = '',
    type = 'button',
    children,
    ...rest
  }: Props = $props();

  const SIZE_CLASS = {
    xs: 'size-6 [&_svg]:size-3',
    sm: 'size-[1.625rem] [&_svg]:size-3.5',
    md: 'size-7 [&_svg]:size-3.5',
    lg: 'size-10 [&_svg]:size-4'
  } as const;
</script>

<button
  {type}
  class={cn(
    buttonVariants({ variant, size: 'icon-sm' }),
    SIZE_CLASS[size],
    'shrink-0',
    quiet && 'text-muted-foreground hover:text-foreground',
    className
  )}
  aria-label={label}
  title={title === undefined ? label : title || undefined}
  {...rest}
>
  {@render children?.()}
</button>
