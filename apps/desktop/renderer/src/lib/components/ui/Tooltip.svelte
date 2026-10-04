<svelte:options runes={true} />

<!--
  Hover/focus tooltip. Portalled so it is never clipped by an `overflow: hidden`
  ancestor (the sidebar rail and the titlebar both clip), and it supports all four
  sides — it previously only did `left` / `right`, which is why several call sites
  fell back to a native `title` attribute instead.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { motionFly } from '$lib/utils/transitions';
  import Portal from './Portal.svelte';

  type Position = 'top' | 'bottom' | 'left' | 'right';

  interface Props {
    label: string;
    position?: Position;
    /** Delay before showing, in ms. Keeps quick pointer passes quiet. */
    delay?: number;
    children?: Snippet;
  }

  let { label, position = 'right', delay = 120, children }: Props = $props();

  const GAP = 8;

  let anchorEl = $state<HTMLElement | undefined>(undefined);
  let tipEl = $state<HTMLElement | undefined>(undefined);
  let visible = $state(false);
  let top = $state(0);
  let left = $state(0);
  let showTimer: ReturnType<typeof setTimeout> | null = null;

  function show() {
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      visible = true;
      showTimer = null;
    }, delay);
  }

  function hide() {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    visible = false;
  }

  /**
   * Resolve the pill's position against its anchor.
   *
   * Everything is computed into locals and assigned to `top` / `left` exactly
   * once at the end. Clamping used to read those two pieces of state back while
   * writing them from inside the placement effect, so the effect depended on
   * its own output and re-ran until Svelte tore down the scheduler with
   * `effect_update_depth_exceeded` — which stops reactivity for the whole app,
   * not just this tooltip.
   */
  function place() {
    if (!anchorEl || !tipEl) return;
    const a = anchorEl.getBoundingClientRect();
    const t = tipEl.getBoundingClientRect();

    let nextTop: number;
    let nextLeft: number;

    switch (position) {
      case 'top':
        nextTop = a.top - t.height - GAP;
        nextLeft = a.left + a.width / 2 - t.width / 2;
        break;
      case 'bottom':
        nextTop = a.bottom + GAP;
        nextLeft = a.left + a.width / 2 - t.width / 2;
        break;
      case 'left':
        nextTop = a.top + a.height / 2 - t.height / 2;
        nextLeft = a.left - t.width - GAP;
        break;
      default:
        nextTop = a.top + a.height / 2 - t.height / 2;
        nextLeft = a.right + GAP;
    }

    top = Math.max(GAP, Math.min(nextTop, window.innerHeight - t.height - GAP));
    left = Math.max(GAP, Math.min(nextLeft, window.innerWidth - t.width - GAP));
  }

  $effect(() => {
    if (!visible || !tipEl) return;
    place();
    const onScroll = () => hide();
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  });

  $effect(() => () => {
    if (showTimer) clearTimeout(showTimer);
  });
</script>

<span
  bind:this={anchorEl}
  class="tooltip-anchor inline-flex"
  role="presentation"
  onmouseenter={show}
  onmouseleave={hide}
  onfocusin={show}
  onfocusout={hide}
>
  {@render children?.()}
</span>

{#if visible && label}
  <Portal>
    <div
      bind:this={tipEl}
      class="tooltip-pill"
      role="tooltip"
      style={`top:${top}px; left:${left}px;`}
      transition:motionFly={{ x: position === 'left' ? 4 : position === 'right' ? -4 : 0, duration: 100 }}
    >
      {label}
    </div>
  </Portal>
{/if}

<style>
  .tooltip-pill {
    position: fixed;
    z-index: var(--z-tooltip);
    white-space: normal;
    max-width: min(22rem, calc(100vw - 16px));
    overflow-wrap: anywhere;
    padding: 0.45rem 0.7rem;
    background: var(--popover);
    border: 0;
    color: var(--popover-foreground);
    border-radius: 0.5rem;
    box-shadow: 0 5px 14px rgb(0 0 0 / 0.28);
    pointer-events: none;
    font-size: var(--text-sm);
    line-height: 1.5;
  }
</style>
