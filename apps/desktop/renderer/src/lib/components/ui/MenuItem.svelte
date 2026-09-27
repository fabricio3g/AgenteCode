<svelte:options runes={true} />

<script lang="ts">
  import type { ComponentType, Snippet } from 'svelte';
  import type { Icon as LucideIcon } from 'lucide-svelte';
  import { Check } from 'lucide-svelte';
  import { cn } from '$lib/utils/cn';

  interface Props {
    label?: string;
    /** A quieter second line under the label. */
    description?: string;
    icon?: ComponentType<LucideIcon>;
    danger?: boolean;
    /** The current choice: marked with a check, not a fill. */
    active?: boolean;
    disabled?: boolean;
    class?: string;
    onselect?: () => void;
    children?: Snippet;
  }

  let {
    label,
    description,
    icon: Icon,
    danger = false,
    active = false,
    disabled = false,
    class: className = '',
    onselect,
    children
  }: Props = $props();
</script>

<button
  type="button"
  role="menuitem"
  class={cn('aui-menu-item', danger && 'is-danger', active && 'is-active', className)}
  aria-current={active ? 'true' : undefined}
  {disabled}
  onclick={onselect}
>
  {#if Icon}<Icon class="size-4" />{/if}
  {#if children}
    {@render children()}
  {:else}
    <span class="aui-menu-item-text">
      <span class="truncate">{label}</span>
      {#if description}<span class="aui-menu-item-hint">{description}</span>{/if}
    </span>
  {/if}
  {#if active}<Check class="aui-menu-check size-3.5" />{/if}
</button>
