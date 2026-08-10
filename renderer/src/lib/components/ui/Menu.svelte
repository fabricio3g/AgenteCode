<svelte:options runes={true} />

<!--
  Portalled dropdown menu.

  Replaces the hand-rolled pattern that was copy-pasted across eight components:
  an absolutely-positioned `.aui-menu` div plus a `fixed inset-0 z-40` scrim to
  catch outside clicks. The scrim swallowed scroll and hover on everything behind
  it and had no keyboard support; this uses a document-level pointer listener and
  a real `role="menu"` with roving focus instead.

  Usage:
    <Menu bind:open placement="top-end">
      {#snippet trigger(props)}
        <IconButton {...props} label={copy.actions.more}><MoreHorizontal /></IconButton>
      {/snippet}
      <MenuItem icon={Pencil} label="Edit" onselect={edit} />
      <MenuItem icon={Trash2} label="Delete" danger onselect={remove} />
    </Menu>
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils/cn';
  import { flyAndScale } from '$lib/utils/transitions';
  import type { MenuPlacement } from './menu';
  import Portal from './Portal.svelte';

  interface TriggerProps {
    onclick: (event: MouseEvent) => void;
    'aria-expanded': boolean;
    'aria-haspopup': 'menu';
  }

  interface Props {
    /** Two-way bindable so callers can close the menu from an item handler. */
    open?: boolean;
    placement?: MenuPlacement;
    /** Minimum panel width in rem. The panel never shrinks below the trigger. */
    minWidth?: string;
    class?: string;
    label?: string;
    trigger: Snippet<[TriggerProps]>;
    children: Snippet;
    onclose?: () => void;
  }

  let {
    open = $bindable(false),
    placement = 'bottom-start',
    minWidth = '9rem',
    class: className = '',
    label = 'Menu',
    trigger,
    children,
    onclose
  }: Props = $props();

  const GAP = 6;

  let anchorEl = $state<HTMLElement | undefined>(undefined);
  let panelEl = $state<HTMLElement | undefined>(undefined);
  let top = $state(0);
  let left = $state(0);
  let anchorWidth = $state(0);

  function close() {
    if (!open) return;
    open = false;
    onclose?.();
  }

  function position() {
    if (!anchorEl || !panelEl) return;
    const anchor = anchorEl.getBoundingClientRect();
    const panel = panelEl.getBoundingClientRect();
    anchorWidth = anchor.width;

    const wantsTop = placement.startsWith('top');
    const wantsEnd = placement.endsWith('end');

    let nextTop = wantsTop ? anchor.top - panel.height - GAP : anchor.bottom + GAP;
    let nextLeft = wantsEnd ? anchor.right - panel.width : anchor.left;

    // Flip rather than overflow the viewport.
    if (nextTop < GAP) nextTop = anchor.bottom + GAP;
    if (nextTop + panel.height > window.innerHeight - GAP) {
      const flipped = anchor.top - panel.height - GAP;
      if (flipped >= GAP) nextTop = flipped;
    }
    nextLeft = Math.max(GAP, Math.min(nextLeft, window.innerWidth - panel.width - GAP));

    top = nextTop;
    left = nextLeft;
  }

  function focusItem(delta: number) {
    if (!panelEl) return;
    const items = Array.from(
      panelEl.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')
    );
    if (!items.length) return;
    const current = items.findIndex((item) => item === document.activeElement);
    const next = current < 0
      ? (delta > 0 ? 0 : items.length - 1)
      : (current + delta + items.length) % items.length;
    items[next]?.focus();
  }

  function handleTrigger(event: MouseEvent) {
    event.stopPropagation();
    open = !open;
    if (!open) onclose?.();
  }

  // Position once the panel exists, then keep it pinned to the anchor.
  $effect(() => {
    if (!open || !panelEl) return;
    position();

    const reposition = () => position();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  });

  $effect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelEl?.contains(target) || anchorEl?.contains(target)) return;
      close();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        (anchorEl?.querySelector('button') as HTMLElement | null)?.focus();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusItem(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusItem(-1);
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  });
</script>

<span bind:this={anchorEl} class="inline-flex">
  {@render trigger({ onclick: handleTrigger, 'aria-expanded': open, 'aria-haspopup': 'menu' })}
</span>

{#if open}
  <Portal>
    <div
      bind:this={panelEl}
      class={cn('aui-menu aui-menu-panel py-1', className)}
      role="menu"
      aria-label={label}
      tabindex="-1"
      style={`top:${top}px; left:${left}px; min-width:max(${minWidth}, ${anchorWidth}px);`}
      transition:flyAndScale={{ y: placement.startsWith('top') ? 4 : -4, start: 0.97, duration: 130 }}
    >
      {@render children()}
    </div>
  </Portal>
{/if}

<style>
  .aui-menu-panel {
    position: fixed;
    z-index: var(--z-menu);
  }
</style>
