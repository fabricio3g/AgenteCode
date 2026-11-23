<svelte:options runes={true} />

<!--
  A drag edge between two panes. It reports the pointer's travel since the
  drag began; the owner turns that into a size and clamps it. Arrow keys
  nudge by 16px so it is usable without a mouse.

  At rest it draws nothing. Hovered, a short hairline (120px, fading at both
  ends) and a 3×20px grip appear on the seam at the pointer, not a line the
  whole height of the window; while dragging both turn ember, so the one thing
  moving is the one thing coloured. No `title`: the browser's tooltip was a
  bigger box than the handle. `visible` splits keep their full line.
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
    onreset,
    fill = false,
    visible = false
  }: {
    /** x: a vertical bar resizing widths; y: a horizontal bar resizing heights. */
    axis?: 'x' | 'y';
    label: string;
    onstart?: () => void;
    /** Pointer travel since the drag started, in px (right/down positive). */
    onresize: (delta: number) => void;
    onend?: () => void;
    oncancel?: () => void;
    /** Double-click: put the pane back at its default size. */
    onreset?: () => void;
    /** Occupy an absolutely positioned splitter hit area. */
    fill?: boolean;
    /** Keep a quiet line and grip visible for conversation splits. */
    visible?: boolean;
  } = $props();

  let dragging = $state(false);
  let handle = $state<HTMLDivElement>();
  /** Where along the seam the grip sits, in px from the handle's start; unset = middle. */
  let at = $state<number | null>(null);

  function track(event: PointerEvent) {
    if (!handle) return;
    const rect = handle.getBoundingClientRect();
    at = axis === 'x' ? event.clientY - rect.top : event.clientX - rect.left;
  }
  let stopGesture: (() => void) | undefined;
  onDestroy(() => stopGesture?.());

  function down(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    stopGesture?.();
    const start = axis === 'x' ? event.clientX : event.clientY;
    dragging = true;
    onstart?.();
    track(event);
    stopGesture = startPointerGesture(event, (next) => { track(next); onresize((axis === 'x' ? next.clientX : next.clientY) - start); }, (cancelled) => {
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
  tabindex="0"
  class="resize-handle"
  class:is-x={axis === 'x'}
  class:is-y={axis === 'y'}
  class:is-dragging={dragging}
  class:fill
  class:persistent={visible}
  bind:this={handle}
  style:--grip-at={at === null ? null : `${at}px`}
  onpointermove={(event) => { if (!dragging) track(event); }}
  onpointerdown={down}
  onkeydown={key}
  ondblclick={() => onreset?.()}
></div>

<style>
  .resize-handle {
    position: relative;
    flex-shrink: 0;
    z-index: 5;
    outline: none;
    touch-action: none;
    --seam: color-mix(in srgb, var(--brand-accent) 68%, transparent);
    --grip: color-mix(in srgb, var(--muted-foreground) 65%, transparent);
  }
  .resize-handle.is-x {
    width: 10px;
    margin: 0 -5px;
    cursor: col-resize;
  }
  .resize-handle.is-y {
    height: 10px;
    margin: -5px 0;
    cursor: row-resize;
  }
  .resize-handle.fill { width: 100%; height: 100%; margin: 0; }

  /* ::after is the hairline segment, ::before the grip; both centred on the
     seam at --grip-at. A quiet resting pill gives a subtle affordance that
     wakes up in the active accent on hover/drag. */
  .resize-handle::after,
  .resize-handle::before {
    content: '';
    position: absolute;
    pointer-events: none;
    transition: opacity var(--motion-instant) var(--motion-ease),
      width var(--motion-instant) var(--motion-ease),
      height var(--motion-instant) var(--motion-ease),
      background-color var(--motion-instant) var(--motion-ease),
      box-shadow var(--motion-instant) var(--motion-ease);
  }
  .resize-handle::after { opacity: 0; }
  .resize-handle::before { z-index: 1; opacity: 0.22; border-radius: 999px; background: var(--grip); }
  .resize-handle.is-x::after {
    left: calc(50% - 0.5px);
    top: calc(var(--grip-at, 50%) - 64px);
    width: 1px;
    height: 128px;
    background: linear-gradient(transparent, var(--seam) 28%, var(--seam) 72%, transparent);
  }
  .resize-handle.is-y::after {
    top: calc(50% - 0.5px);
    left: calc(var(--grip-at, 50%) - 64px);
    height: 1px;
    width: 128px;
    background: linear-gradient(90deg, transparent, var(--seam) 28%, var(--seam) 72%, transparent);
  }
  .resize-handle.is-x::before { width: 2px; height: 24px; left: calc(50% - 1px); top: calc(var(--grip-at, 50%) - 12px); }
  .resize-handle.is-y::before { height: 2px; width: 24px; top: calc(50% - 1px); left: calc(var(--grip-at, 50%) - 12px); }

  .resize-handle:hover::before,
  .resize-handle:focus-visible::before,
  .resize-handle.is-dragging::before {
    opacity: 1;
    background: var(--brand-accent);
  }
  .resize-handle.is-x:hover::before,
  .resize-handle.is-x:focus-visible::before,
  .resize-handle.is-x.is-dragging::before { width: 3px; height: 34px; left: calc(50% - 1.5px); top: calc(var(--grip-at, 50%) - 17px); }
  .resize-handle.is-y:hover::before,
  .resize-handle.is-y:focus-visible::before,
  .resize-handle.is-y.is-dragging::before { height: 3px; width: 34px; top: calc(50% - 1.5px); left: calc(var(--grip-at, 50%) - 17px); }

  .resize-handle:hover::after,
  .resize-handle:focus-visible::after,
  .resize-handle.is-dragging::after { opacity: 1; }
  .resize-handle.is-dragging { --seam: var(--brand-accent); --grip: var(--brand-accent); }
  .resize-handle.is-dragging::before { box-shadow: 0 0 8px var(--glow); }

  /* Conversation splits keep a quiet full-length line and a resting grip. */
  .resize-handle.persistent::after { opacity: 1; background: var(--split-line); }
  .resize-handle.persistent.is-x::after { top: 0; height: 100%; }
  .resize-handle.persistent.is-y::after { left: 0; width: 100%; }
  .resize-handle.persistent::before { opacity: .45; --grip: var(--brand-accent); }
  .resize-handle.persistent:hover::before, .resize-handle.persistent.is-dragging::before { opacity: 1; }

  @media (prefers-reduced-motion: reduce) { .resize-handle::before, .resize-handle::after { transition: none; } }
  :global(.a11y-reduce-motion) .resize-handle::before, :global(.a11y-reduce-motion) .resize-handle::after { transition: none; }
</style>
