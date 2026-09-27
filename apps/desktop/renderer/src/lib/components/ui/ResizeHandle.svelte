<svelte:options runes={true} />

<!--
  A drag edge between two panes. It reports the pointer's travel since the
  drag began; the owner turns that into a size and clamps it. Arrow keys
  nudge by 16px so it is usable without a mouse.
-->

<script lang="ts">
  let {
    axis = 'x',
    label,
    onstart,
    onresize,
    onend
  }: {
    /** x: a vertical bar resizing widths; y: a horizontal bar resizing heights. */
    axis?: 'x' | 'y';
    label: string;
    onstart?: () => void;
    /** Pointer travel since the drag started, in px (right/down positive). */
    onresize: (delta: number) => void;
    onend?: () => void;
  } = $props();

  let dragging = $state(false);

  function down(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const start = axis === 'x' ? event.clientX : event.clientY;
    dragging = true;
    onstart?.();
    const move = (e: PointerEvent) => onresize((axis === 'x' ? e.clientX : e.clientY) - start);
    const up = () => {
      dragging = false;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      onend?.();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
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
    width: 6px;
    margin: 0 -3px;
    cursor: col-resize;
  }
  .resize-handle.is-y {
    height: 6px;
    margin: -3px 0;
    cursor: row-resize;
  }
  .resize-handle::after {
    content: '';
    position: absolute;
    background: transparent;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .resize-handle.is-x::after {
    inset: 0 2px;
  }
  .resize-handle.is-y::after {
    inset: 2px 0;
  }
  .resize-handle:hover::after,
  .resize-handle:focus-visible::after,
  .resize-handle.is-dragging::after {
    background: var(--ring, var(--primary));
  }
</style>
