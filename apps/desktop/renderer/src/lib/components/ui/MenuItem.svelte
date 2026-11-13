<svelte:options runes={true} />

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import type { Icon as AppIcon } from '$lib/icons';
  import { Check } from '$lib/icons';
  import { cn } from '$lib/utils/cn';

  interface Props extends Omit<HTMLButtonAttributes, 'role' | 'class' | 'children'> {
    label?: string;
    /** A quieter second line under the label. */
    description?: string;
    icon?: AppIcon;
    danger?: boolean;
    /** The current choice: marked with a check, not a fill. */
    active?: boolean;
    disabled?: boolean;
    class?: string;
    /** `menuitem` inside a Menu; a plain `button` when the row sits in a panel. */
    role?: 'menuitem' | 'button';
    /** Choosing it leaves the menu open (a row that asks to confirm first). */
    keepOpen?: boolean;
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
    role = 'menuitem',
    keepOpen = false,
    onselect,
    children,
    ...rest
  }: Props = $props();
</script>

<button
  type="button"
  {role}
  class={cn('ui-menu-item', danger && 'is-danger', active && 'is-active', className)}
  aria-current={active ? 'true' : undefined}
  {disabled}
  data-keep-open={keepOpen ? '' : undefined}
  {...rest}
  onclick={onselect}
>
  {#if Icon}<Icon class="size-4" />{/if}
  {#if children}
    {@render children()}
  {:else}
    <span class="ui-menu-item-text">
      <span class="truncate">{label}</span>
      {#if description}<span class="ui-menu-item-hint">{description}</span>{/if}
    </span>
  {/if}
  {#if active}<Check class="ui-menu-check size-3.5" />{/if}
</button>
