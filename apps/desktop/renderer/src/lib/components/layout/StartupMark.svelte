<svelte:options runes={true} />

<!--
  The startup mark.

  Same mark, same tiles as the brand icon, but drawn from its own data so the
  Matrix Field can move, in two beats:

  1. Assembly — the tiles light up from the event horizon outward, a ripple
     across the field, so the mark builds itself instead of fading in as one
     picture (`enter`, ~0.55 s edge to edge).
  2. Orbit — a comet runs the accretion ring on the -28° tilt the icon is built
     from: a bright head that swells the tile it crosses and a trail that fades
     back to the mark's resting shade, once every orbit (`delay`, the tile's
     angle in the disk's own ellipse).

  The assembly rides on a group per tile and the orbit on the tile itself, so
  the two never fight over one property. Nothing here is a spinner; the screen
  stays quiet, and motion off shows the plain icon.
-->

<script lang="ts">
  import { QUASAR_ORBIT_PERIOD, quasarTiles } from '$lib/utils/quasar-field';

  const tiles = quasarTiles();
</script>

<svg
  class="startup-mark"
  viewBox="0 0 120 120"
  aria-hidden="true"
  focusable="false"
  style="--orbit-period: {QUASAR_ORBIT_PERIOD}s"
>
  <g transform="translate(60 60) scale(0.87) translate(-60 -60)">
    {#each tiles as tile}
      <g class="tile-in" style="--enter: {tile.enter}s">
        <rect
          class="tile"
          x={tile.x}
          y={tile.y}
          width={tile.size}
          height={tile.size}
          rx={tile.rx}
          fill="#ffffff"
          style="--base: {tile.opacity}; animation-delay: {tile.delay}s"
        />
      </g>
    {/each}
  </g>
</svg>

<style>
  .startup-mark {
    width: 16rem;
    height: 16rem;
    overflow: visible;
  }

  /* Beat 1: each tile arrives from a little smaller and fully dark, in the
     order the ripple reaches it. */
  .tile-in {
    transform-box: fill-box;
    transform-origin: center;
    animation: quasar-assemble 520ms cubic-bezier(0.22, 1, 0.36, 1) var(--enter) both;
  }

  @keyframes quasar-assemble {
    from {
      opacity: 0;
      transform: scale(0.55);
    }
    60% {
      opacity: 1;
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  /* Beat 2: the comet. The head (50%) lights the tile to full and swells it;
     the trail behind it (50–72%) eases back to the resting shade, so the light
     reads as travelling, not blinking. */
  .tile {
    opacity: calc(var(--base) * 0.62);
    transform-box: fill-box;
    transform-origin: center;
    animation: quasar-orbit var(--orbit-period) linear infinite;
  }

  @keyframes quasar-orbit {
    0%,
    47% {
      opacity: calc(var(--base) * 0.62);
      transform: scale(1);
    }
    50% {
      opacity: 1;
      transform: scale(1.1);
    }
    56% {
      opacity: calc(var(--base) * 0.92);
      transform: scale(1.03);
    }
    72%,
    100% {
      opacity: calc(var(--base) * 0.62);
      transform: scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tile-in,
    .tile {
      animation: none;
      opacity: var(--base, 1);
    }
  }
  :global(html.a11y-reduce-motion) .tile-in,
  :global(html.a11y-reduce-motion) .tile {
    animation: none;
    opacity: var(--base, 1);
  }
</style>
