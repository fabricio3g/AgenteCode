<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { LoaderCircle } from 'lucide-svelte';
  import { cn } from '$lib/utils/cn';
  import { buttonVariants, type ButtonSize, type ButtonVariant } from './button/variants';

  type Props = HTMLButtonAttributes & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    class?: string;
    loading?: boolean;
    loadingLabel?: string;
  };

  let {
    variant = 'default',
    size = 'default',
    class: className = '',
    type = 'button',
    loading = false,
    loadingLabel,
    disabled = false,
    children,
    ...rest
  }: Props = $props();
</script>

<button
  {type}
  class={cn(buttonVariants({ variant, size }), className)}
  disabled={disabled || loading}
  aria-busy={loading}
  {...rest}
>
  {#if loading}
    <LoaderCircle class="animate-spin" aria-hidden="true" />
    {#if loadingLabel}{loadingLabel}{:else}{@render children?.()}{/if}
  {:else}
    {@render children?.()}
  {/if}
</button>
