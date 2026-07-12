<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  import { buttonVariants, type ButtonSize, type ButtonVariant } from './button/variants';

  type Props = HTMLButtonAttributes & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    class?: string;
  };

  let {
    variant = 'default',
    size = 'default',
    class: className = '',
    type = 'button',
    children,
    ...rest
  }: Props = $props();
</script>

<button
  {type}
  class={cn(buttonVariants({ variant, size }), className)}
  {...rest}
>
  {@render children?.()}
</button>
