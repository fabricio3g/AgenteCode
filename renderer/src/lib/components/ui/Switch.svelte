<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';

  type Props = Omit<HTMLButtonAttributes, 'onchange'> & {
    checked?: boolean;
    onchange?: (checked: boolean) => void;
    class?: string;
    label?: string;
  };

  let {
    checked = $bindable(false),
    onchange,
    class: className = '',
    label,
    disabled = false,
    ...rest
  }: Props = $props();

  function toggle() {
    if (disabled) return;
    checked = !checked;
    onchange?.(checked);
  }
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  class={cn(
    'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent outline-none transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease)] focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50',
    checked ? 'bg-primary' : 'bg-muted',
    className
  )}
  onclick={toggle}
  {...rest}
>
  <span
    class={cn(
      'pointer-events-none block size-4 rounded-full bg-primary-foreground shadow-sm transition-transform duration-[var(--motion-normal)] ease-[var(--motion-ease)]',
      checked ? 'translate-x-4' : 'translate-x-0'
    )}
  ></span>
</button>
