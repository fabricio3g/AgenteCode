<svelte:options runes={true} />

<!--
  The message hover bar. One implementation for both roles.

  Primary actions sit inline; everything else collapses into a single overflow
  menu. Branch paging, when present, is rendered above the menu items rather
  than as a row wedged inside them.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Check, MoreHorizontal } from 'lucide-svelte';
  import { Menu, MenuItem } from '$lib/components/ui';
  import { copy } from '$lib/copy';
  import type { MessageAction } from './message-actions';

  interface Props {
    actions: MessageAction[];
    align?: 'start' | 'end';
    /** Keep the bar on screen regardless of hover. */
    visible?: boolean;
    /** Extra content rendered at the top of the overflow menu. */
    menuHeader?: Snippet;
    /** Raised while the menu is open so the parent can keep the bar visible. */
    onmenutoggle?: (open: boolean) => void;
  }

  let { actions, align = 'start', visible = false, menuHeader, onmenutoggle }: Props = $props();

  const CONFIRM_MS = 1800;

  let menuOpen = $state(false);
  let confirmedId = $state<string | null>(null);
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  const primary = $derived(actions.filter((action) => action.primary));
  const overflow = $derived(actions.filter((action) => !action.primary));
  const hasOverflow = $derived(overflow.length > 0 || !!menuHeader);

  function run(action: MessageAction) {
    action.run();
    if (!action.confirms) return;
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmedId = action.id;
    confirmTimer = setTimeout(() => {
      confirmedId = null;
      confirmTimer = null;
    }, CONFIRM_MS);
  }

  function runFromMenu(action: MessageAction) {
    menuOpen = false;
    onmenutoggle?.(false);
    run(action);
  }

  $effect(() => {
    onmenutoggle?.(menuOpen);
  });

  $effect(() => () => {
    if (confirmTimer) clearTimeout(confirmTimer);
  });

  // Kept visible while a confirmation is showing so the check is actually seen.
  const shown = $derived(visible || menuOpen || confirmedId !== null);
</script>

<div class="message-action-bar {align === 'end' ? 'justify-end' : ''} {shown ? 'visible' : ''}">
  {#each primary as action (action.id)}
    {@const Icon = action.active && action.activeIcon ? action.activeIcon : action.icon}
    {@const label = action.active && action.activeLabel ? action.activeLabel : action.label}
    <button
      type="button"
      class="msg-action-btn"
      class:copied={confirmedId === action.id}
      class:danger={action.danger}
      disabled={action.disabled}
      onclick={() => run(action)}
      aria-label={label}
      title={label}
    >
      {#if confirmedId === action.id}
        <Check class="size-3" />
      {:else}
        <Icon class="size-3" />
      {/if}
    </button>
  {/each}

  {#if hasOverflow}
    <Menu
      bind:open={menuOpen}
      placement={align === 'end' ? 'top-end' : 'top-start'}
      label="Message actions"
    >
      {#snippet trigger(props)}
        <button
          type="button"
          class="msg-action-btn"
          aria-label={copy.actions.more}
          title={copy.actions.more}
          {...props}
        >
          <MoreHorizontal class="size-3" />
        </button>
      {/snippet}

      {#if menuHeader}{@render menuHeader()}{/if}

      {#each overflow as action (action.id)}
        <MenuItem
          icon={action.active && action.activeIcon ? action.activeIcon : action.icon}
          label={action.active && action.activeLabel ? action.activeLabel : action.label}
          danger={action.danger}
          disabled={action.disabled}
          onselect={() => runFromMenu(action)}
        />
      {/each}
    </Menu>
  {/if}
</div>
