<svelte:options runes={true} />
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Portal from '$lib/components/ui/Portal.svelte';
  import { placePanel, type MenuPlacement } from '$lib/components/ui/menu';

  let { anchor, id, label, tooltip = false, placement = 'top-start', onclose, children }: {
    anchor: HTMLButtonElement | undefined;
    id: string;
    label: string;
    tooltip?: boolean;
    placement?: MenuPlacement;
    onclose: () => void;
    children: Snippet;
  } = $props();
  let panel = $state<HTMLDivElement>();
  let position = $state<ReturnType<typeof placePanel> | null>(null);

  $effect(() => {
    if (!anchor || !panel) return;
    const reposition = () => {
      if (!anchor || !panel) return;
      position = placePanel(anchor.getBoundingClientRect(), {
        width: panel.offsetWidth,
        height: Math.max(panel.offsetHeight, panel.scrollHeight + 2)
      }, placement);
    };
    reposition();
    if (!tooltip) panel.querySelector('input')?.focus();
    const observer = new ResizeObserver(reposition);
    observer.observe(anchor);
    observer.observe(panel);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  });

  $effect(() => {
    const outside = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node | null;
      if (target && !anchor?.contains(target) && !panel?.contains(target)) onclose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (!tooltip) anchor?.focus();
      onclose();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
    };
  });
</script>

<Portal>
  <div bind:this={panel} {id} role={tooltip ? 'tooltip' : 'dialog'} aria-label={label}
    class="composer-card" class:is-tooltip={tooltip}
    style:visibility={position ? 'visible' : 'hidden'}
    style:top={`${position?.top ?? 0}px`} style:left={`${position?.left ?? 0}px`}
    style:max-height={position ? `${position.maxHeight}px` : undefined}
    style:max-width={position ? `${position.maxWidth}px` : undefined}>
    {@render children()}
  </div>
</Portal>

<style>
  .composer-card {
    position: fixed;
    z-index: 100;
    width: max-content;
    overflow: auto;
    padding: 0.75rem;
    background: var(--popover);
    color: var(--foreground);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    font-size: 12px;
    line-height: 1.5;
  }
  .is-tooltip { pointer-events: none; }
</style>
