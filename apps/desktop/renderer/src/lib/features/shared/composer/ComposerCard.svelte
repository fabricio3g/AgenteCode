<svelte:options runes={true} />
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { flyAndScale } from '$lib/utils/transitions';
  import Portal from '$lib/components/ui/Portal.svelte';
  import { placePanel, type MenuPlacement } from '$lib/components/ui/menu';

  let { anchor, id, label, tooltip = false, bright = false, placement = 'top-start', onclose, children }: {
    anchor: HTMLButtonElement | undefined;
    id: string;
    label: string;
    tooltip?: boolean;
    /** A white, borderless card on a soft two-layer shadow (the thinking slider). */
    bright?: boolean;
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
    if (!tooltip) panel.querySelector<HTMLElement>('input, [role="slider"]')?.focus();
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
    in:flyAndScale={{ y: placement.startsWith('top') ? 3 : -3, start: 0.98, duration: 150 }}
    style:transform-origin={`${placement.startsWith('top') ? 'bottom' : 'top'} ${placement.endsWith('end') ? 'right' : 'left'}`}
    class="composer-card" class:is-tooltip={tooltip} class:is-bright={bright}
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
    z-index: var(--z-menu);
    width: max-content;
    overflow: auto;
    padding: 0.75rem;
    background: var(--float-bg);
    color: var(--foreground);
    border: 1px solid var(--float-border);
    border-radius: var(--float-radius);
    box-shadow: var(--float-shadow);
    font-size: var(--text-xs);
    line-height: 1.5;
  }
  .is-tooltip { pointer-events: none; }

  /* The thinking slider: the same surface, a little tighter. */
  .is-bright {
    padding: 0.625rem 0.75rem 0.5rem;
  }
</style>
