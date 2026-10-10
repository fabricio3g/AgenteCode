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
  import type { ButtonVariant } from './button/variants';
  import Button from './Button.svelte';

  type Props = Omit<HTMLButtonAttributes, 'aria-label' | 'title'> & {
    /** Accessible name. Also used as the native tooltip unless `title` is set. */
    label: string;
    ref?: HTMLButtonElement;
    /** Override the native tooltip; defaults to `label`. Pass '' to suppress. */
    title?: string;
    variant?: ButtonVariant;
    size?: 'xs' | 'sm' | 'md' | 'lg';
    /** Subtle variant used by message hover bars: transparent until hovered. */
    quiet?: boolean;
    loading?: boolean;
    loadingLabel?: string;
    class?: string;
    children?: Snippet;
  };

  let {
    label,
    ref = $bindable(),
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
    xs: 'size-[var(--ui-icon-button-size,1.5rem)] [&_svg]:size-3',
    sm: 'size-[var(--ui-icon-button-size,1.625rem)] [&_svg]:size-3.5',
    md: 'size-[var(--ui-icon-button-size,1.75rem)] [&_svg]:size-3.5',
    lg: 'size-[var(--ui-icon-button-size,2.5rem)] [&_svg]:size-4'
  } as const;
</script>

<Button
  {variant}
  size="icon-sm"
  bind:ref
  {type}
  class={cn(
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
</Button>
