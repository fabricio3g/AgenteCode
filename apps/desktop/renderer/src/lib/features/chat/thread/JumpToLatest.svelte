<svelte:options runes={true} />

<!--
  Back to the latest output, drawn as a live object.

  The circle says where it goes — an arrow down — except while a run is working,
  when it wears the tile meter instead. That is the point: the status row that
  would say "still working" sits at the bottom of the transcript, exactly what
  the reader scrolled away from, so the button carries the same news (rain while
  events arrive, a drizzle once they stop, an amber square while an approval
  waits, the still frame once a stop is asked for). Hovering, or reaching it
  from the keyboard, brings the arrow back — and lifts the circle onto its own
  white surface ringed in the brand orange, so the swap reads as a state rather
  than as the button emptying out: the meter reports, the arrow invites.

  One glyph is visible at a time, so the swap is a single custom property —
  no layout shift, no JS hover state, no repaint of anything else.

  Decorative: the label names the action and the transcript's own live region
  says what is happening, so nothing here announces itself twice.
-->

<script lang="ts">
  import { ArrowDown } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import TileMeter from '$lib/features/code/TileMeter.svelte';
  import type { TileMeterMode } from '$lib/features/code/tile-meter';

  let {
    working = false,
    mode = 'quiet',
    variant = 'chrome',
    class: className = '',
    onclick
  }: {
    /** A run is live, so the meter takes the arrow's place. */
    working?: boolean;
    /** How alive that run is (see `tile-meter.ts`). */
    mode?: TileMeterMode;
    /** `chrome` sits on the composer; `float` hovers over the transcript. */
    variant?: 'chrome' | 'float';
    class?: string;
    onclick: () => void;
  } = $props();
</script>

<button
  type="button"
  class="jump-latest is-{variant} {className}"
  class:is-working={working}
  aria-label={$t('chat.jumpToLatest')}
  title={$t('chat.jumpToLatest')}
  {onclick}
>
  {#if working}<span class="meter"><TileMeter {mode} /></span>{/if}
  <span class="arrow"><ArrowDown class="size-4" /></span>
</button>

<style>
  .jump-latest {
    /* 1: the arrow is the button. Whichever glyph the pointer is on wins. */
    --jump-arrow: 1;
    display: inline-grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--card);
    color: var(--muted-foreground);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
    /* The rain sizes off `--rain-cell` in em, so this circle's font-size is the
       meter's size: one step up from the status row's 0.3em fills 2rem without
       crowding the arrow's optical centre. */
    font-size: var(--text-sm);
    --rain-cell: 0.38em;
    cursor: pointer;
    animation: jump-in var(--motion-fast) var(--motion-ease);
    transition:
      color var(--motion-fast) var(--motion-ease),
      background-color var(--motion-fast) var(--motion-ease),
      border-color var(--motion-fast) var(--motion-ease);
  }

  /* Over the transcript it has to read as floating; on the composer it is chrome. */
  .jump-latest.is-float {
    background: var(--popover);
    box-shadow: var(--shadow-lg);
  }

  /* Hovering — or reaching it from the keyboard — never empties the circle: it
     lifts it onto its own surface and rings it in the brand orange the meter
     rains in, so the arrow arriving reads as an invitation, not as a fade. */
  .jump-latest:is(:hover, :focus-visible) {
    background: var(--popover);
    border-color: color-mix(in oklab, rgb(var(--tile-hi)) 45%, transparent);
    color: var(--foreground);
  }

  .jump-latest:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 35%, transparent);
  }

  /* Both glyphs claim the same cell, so swapping one for the other moves nothing. */
  .meter,
  .arrow {
    grid-area: 1 / 1;
    display: inline-flex;
    transition: opacity var(--motion-fast) var(--motion-ease);
  }

  .meter {
    opacity: calc(1 - var(--jump-arrow));
  }

  .arrow {
    opacity: var(--jump-arrow);
  }

  .jump-latest.is-working {
    --jump-arrow: 0;
  }

  /* Only a pointer that can hover gets the reveal. On touch there is no "about
     to click" state, so the informative glyph keeps the circle and the label
     still spells out the action. */
  @media (hover: hover) {
    .jump-latest:hover,
    .jump-latest:focus-visible {
      --jump-arrow: 1;
    }
  }

  @keyframes jump-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .jump-latest {
      animation: none;
      transition: none;
    }

    .meter,
    .arrow {
      transition: none;
    }
  }
</style>
