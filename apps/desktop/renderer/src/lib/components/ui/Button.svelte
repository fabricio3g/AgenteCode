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
  /* Zero specificity (`:where`): this reset must lose to the utilities and
     caller classes on the same element. Scoped as `.ui-action` it carried
     (0,2,0) and beat every Tailwind class (0,1,0), so a plain button whose
     fill differed from the text around it — bg-primary + text-primary-foreground
     — rendered its label in the inherited colour, invisible on its own fill. */
  :global(:where(.ui-action)) { font:inherit; color:inherit; border-radius:var(--radius-sm); transition:background-color var(--motion-fast), color var(--motion-fast); }
  :global(:where(.ui-action:focus-visible)) { outline:2px solid var(--ring); outline-offset:2px; }
  :global(:where(.ui-action:disabled)) { opacity:0.5; cursor:not-allowed; }
</style>
