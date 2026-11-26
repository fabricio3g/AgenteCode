<svelte:options runes={true} />

<!--
  The startup mark.

  Same mark, same tiles as the brand icon, but drawn from its own data so the
  Matrix Field can light up: a highlight runs around the accretion ring once
  every orbit, on the -28° tilt the icon is built from, and settles back to the
  mark's resting shade between passes. The tiles swell a hair as it crosses
  them, so the sweep reads on the bright core as well as the dim dust.

  Nothing here is a spinner. The quasar orbits because it is a quasar; the
  screen stays quiet, and motion off shows the plain icon.
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
    {/each}
  </g>
</svg>

<style>
  .startup-mark {
    width: 16rem;
    height: 16rem;
    animation: startup-mark-in 400ms var(--motion-ease-out) both;
  }

  .tile {
    opacity: var(--base);
    transform-box: fill-box;
    transform-origin: center;
    animation: quasar-orbit var(--orbit-period) linear infinite;
  }

  /* A narrow band travels the ring; the rest of the field keeps the mark's
     resting shade, so the light has somewhere to travel to. */
  @keyframes quasar-orbit {
    0%,
    46% {
      opacity: calc(var(--base) * 0.66);
      transform: scale(1);
    }
    50% {
      opacity: 1;
      transform: scale(1.06);
    }
    54%,
    100% {
      opacity: calc(var(--base) * 0.66);
      transform: scale(1);
    }
  }

  @keyframes startup-mark-in {
    from {
      opacity: 0;
      transform: translateY(4px) scale(0.96);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .startup-mark,
    .tile {
      animation: none;
    }
  }
</style>
