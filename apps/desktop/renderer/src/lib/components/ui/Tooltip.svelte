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
  import { shortcutKeys } from '$lib/utils/shortcuts';

  type Position = 'top' | 'bottom' | 'left' | 'right';

  interface Props {
    label: string;
    /** A keyboard shortcut for the same action (`mod+shift+k`), shown as key caps after the label. */
    shortcut?: string;
    content?: Snippet;
    class?: string;
    position?: Position;
    /** Delay before showing, in ms. Keeps quick pointer passes quiet. */
    delay?: number;
    children?: Snippet;
  }

  let { label, shortcut, content, class: className = '', position = 'right', delay = 120, children }: Props = $props();

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
  class="tooltip-anchor inline-flex {className}"
  role="presentation"
  onpointerdown={hide}
  ondragstart={hide}
  onmouseenter={show}
  onmouseleave={hide}
  onfocusin={(event) => {
    // Keyboard focus names the control; focus a dialog places on open, or that
    // follows a click, does not pop a pill over the content.
    if ((event.target as HTMLElement).matches?.(':focus-visible')) show();
  }}
  onfocusout={hide}
>
  {@render children?.()}
</span>

{#if visible && (label || content)}
  <Portal>
    <div
      bind:this={tipEl}
      class="tooltip-pill"
      role="tooltip"
      style={`top:${top}px; left:${left}px;`}
      transition:motionFly={{ x: position === 'left' ? 4 : position === 'right' ? -4 : 0, duration: 100 }}
    >
      {#if content}{@render content()}{:else}{label}{/if}
      {#if shortcut}
        <span class="tooltip-keys" aria-label={shortcut}>
          {#each shortcutKeys(shortcut) as key, i (i)}<kbd>{key}</kbd>{/each}
        </span>
      {/if}
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
    background: var(--float-bg);
    border: 1px solid var(--float-border);
    color: var(--popover-foreground);
    border-radius: var(--float-row-radius);
    box-shadow: var(--float-shadow);
    pointer-events: none;
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .tooltip-pill::after {
    content: '';
    position: absolute;
    top: 0;
    left: 16%;
    right: 16%;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--composer-crown), transparent);
    pointer-events: none;
  }

  /* Quiet PBT key caps after the label: the shortcut, never louder than the name. */
  .tooltip-keys {
    display: inline-flex;
    gap: 0.1875rem;
    margin-inline-start: 0.5rem;
    vertical-align: 0.0625rem;
  }

  .tooltip-keys kbd {
    display: inline-flex;
    min-width: 1.125rem;
    height: 1.125rem;
    align-items: center;
    justify-content: center;
    padding: 0 0.25rem;
    border: 1px solid var(--float-border);
    border-radius: 0.3125rem;
    background: color-mix(in srgb, var(--foreground) 4%, transparent);
    box-shadow: 0 1px 0 var(--float-border), inset 0 1px 0 rgb(255 255 255 / 0.08);
    color: var(--muted-foreground);
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    font-size: var(--text-xs);
    line-height: 1;
  }
</style>
