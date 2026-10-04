<svelte:options runes={true} />

<!--
  A drag edge between two panes. It reports the pointer's travel since the
  drag began; the owner turns that into a size and clamps it. Arrow keys
  nudge by 16px so it is usable without a mouse.
-->

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { startPointerGesture } from '$lib/utils/pointer-gesture';
  let {
    axis = 'x',
    label,
    onstart,
    onresize,
    onend,
    oncancel,
    fill = false
  }: {
    /** x: a vertical bar resizing widths; y: a horizontal bar resizing heights. */
    axis?: 'x' | 'y';
    label: string;
    onstart?: () => void;
    /** Pointer travel since the drag started, in px (right/down positive). */
    onresize: (delta: number) => void;
    onend?: () => void;
    oncancel?: () => void;
    /** Occupy an absolutely positioned splitter hit area. */
    fill?: boolean;
  } = $props();

  let dragging = $state(false);
  let stopGesture: (() => void) | undefined;
  onDestroy(() => stopGesture?.());

  function down(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    stopGesture?.();
    const start = axis === 'x' ? event.clientX : event.clientY;
    dragging = true;
    onstart?.();
    stopGesture = startPointerGesture(event, (next) => onresize((axis === 'x' ? next.clientX : next.clientY) - start), (cancelled) => {
      dragging = false;
      stopGesture = undefined;
      if (cancelled && oncancel) oncancel(); else onend?.();
    });
  }

  function key(event: KeyboardEvent) {
    const step = event.shiftKey ? 64 : 16;
    const map: Record<string, number> = axis === 'x'
      ? { ArrowLeft: -step, ArrowRight: step }
      : { ArrowUp: -step, ArrowDown: step };
    const delta = map[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    onstart?.();
    onresize(delta);
    onend?.();
  }
</script>

<!-- A focusable separator is the ARIA pattern for a splitter. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
  aria-label={label}
  title={label}
  tabindex="0"
  class="resize-handle"
  class:is-x={axis === 'x'}
  class:is-y={axis === 'y'}
  class:is-dragging={dragging}
  class:fill
  onpointerdown={down}
  onkeydown={key}
></div>

<style>
  .resize-handle {
    position: relative;
    flex-shrink: 0;
    z-index: 5;
    outline: none;
    touch-action: none;
  }
  .resize-handle.is-x {
    width: 14px;
    margin: 0 -7px;
    cursor: col-resize;
  }
  .resize-handle.is-y {
    height: 14px;
    margin: -7px 0;
    cursor: row-resize;
  }
  .resize-handle.fill { width: 100%; height: 100%; margin: 0; }
  .resize-handle::after {
    content: '';
    position: absolute;
    background: transparent;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .resize-handle::before { content: ''; position: absolute; z-index: 1; border-radius: 4px; background: var(--muted-foreground); opacity: 0; transition: opacity var(--motion-fast) var(--motion-ease); }
  .resize-handle.is-x::before { width: 3px; height: 28px; left: calc(50% - 1.5px); top: calc(50% - 14px); }
  .resize-handle.is-y::before { height: 3px; width: 28px; top: calc(50% - 1.5px); left: calc(50% - 14px); }
  .resize-handle.is-x::after {
    inset: 0 auto 0 50%;
    width: 1px;
  }
  .resize-handle.is-y::after {
    inset: 50% 0 auto;
    height: 1px;
  }
  .resize-handle:hover::after,
  .resize-handle:focus-visible::after,
  .resize-handle.is-dragging::after {
    background: color-mix(in srgb, var(--muted-foreground) 40%, transparent);
  }
  .resize-handle:hover::before, .resize-handle:focus-visible::before, .resize-handle.is-dragging::before { opacity: .85; }
  @media (prefers-reduced-motion: reduce) { .resize-handle::before, .resize-handle::after { transition: none; } }
  :global(.a11y-reduce-motion) .resize-handle::before, :global(.a11y-reduce-motion) .resize-handle::after { transition: none; }
</style>
