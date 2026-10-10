<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { LoaderCircle } from 'lucide-svelte';
  import { cn } from '$lib/utils/cn';
  import { buttonVariants, type ButtonSize, type ButtonVariant } from './button/variants';

  type Props = HTMLButtonAttributes & {
    variant?: ButtonVariant | 'plain';
    ref?: HTMLButtonElement;
    size?: ButtonSize;
    class?: string;
    loading?: boolean;
    loadingLabel?: string;
  };

  let {
    variant = 'default',
    ref = $bindable(),
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
  bind:this={ref}
  {type}
  class={cn(variant === 'plain' ? 'ui-action' : buttonVariants({ variant, size }), className)}
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

<style>
  .ui-action { font:inherit; color:inherit; border-radius:var(--radius-sm); transition:background-color var(--motion-fast), color var(--motion-fast); }
  .ui-action:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
  .ui-action:disabled { opacity:0.5; cursor:not-allowed; }
</style>
