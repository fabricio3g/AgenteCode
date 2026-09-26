<svelte:options runes={true} />

<!--
  The message hover bar. One implementation for both roles.

  Every action is an inline icon (edit, listen and delete included), so
  nothing hides behind a "…" menu. The menu only remains for branch paging.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Check } from 'lucide-svelte';
  import type { MessageAction } from './message-actions';

  interface Props {
    actions: MessageAction[];
    align?: 'start' | 'end';
    /** Keep the bar on screen regardless of hover. */
    visible?: boolean;
    /** Extra inline content at the start of the row (branch paging). */
    menuHeader?: Snippet;
    /** Raised while the menu is open so the parent can keep the bar visible. */
    onmenutoggle?: (open: boolean) => void;
  }

  let { actions, align = 'start', visible = false, menuHeader, onmenutoggle }: Props = $props();

  const CONFIRM_MS = 1800;

  let menuOpen = $state(false);
  let confirmedId = $state<string | null>(null);
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  // Primary first, then the rest; destructive actions last.
  const inline = $derived([
    ...actions.filter((action) => action.primary),
    ...actions.filter((action) => !action.primary && !action.danger),
    ...actions.filter((action) => !action.primary && action.danger)
  ]);

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
  <!-- Branch paging (‹ 1/2 ›), when present, leads the row. -->
  {#if menuHeader}{@render menuHeader()}{/if}
  {#each inline as action (action.id)}
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

</div>
