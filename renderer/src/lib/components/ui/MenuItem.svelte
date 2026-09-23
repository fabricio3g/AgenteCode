<svelte:options runes={true} />

<script lang="ts">
  import type { ComponentType, Snippet } from 'svelte';
  import type { Icon as LucideIcon } from 'lucide-svelte';
  import { cn } from '$lib/utils/cn';

  interface Props {
    label?: string;
    icon?: ComponentType<LucideIcon>;
    danger?: boolean;
    active?: boolean;
    disabled?: boolean;
    class?: string;
    onselect?: () => void;
    children?: Snippet;
  }

  let {
    label,
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
  class={cn('aui-menu-item text-xs', danger && 'is-danger', active && 'is-active', className)}
  {disabled}
  onclick={onselect}
>
  {#if Icon}<Icon class="size-3.5" />{/if}
  {#if children}{@render children()}{:else}{label}{/if}
</button>
