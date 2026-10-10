<svelte:options runes={true} />

<!--
  The landing mosaic behind the empty-state greeting: small tiles in the
  brand's tile colours that light up and fade out one by one at random — a
  sparse twinkle, not rain — under a mask that keeps the middle (where the text
  sits) quiet and fades the field out at its edges. Decorative; under reduced
  motion it holds a still scatter.
-->

<script lang="ts">
  const COLS = 34;
  const ROWS = 6;

  /** Seeded so the scatter is the same on every visit (and in tests). */
  function seeded(seed: number) {
    return () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
  }
  const random = seeded(7);

  // Only about a third of the cells ever light; each on its own clock.
  const tiles = Array.from({ length: COLS * ROWS }, () => {
    const live = random() < 0.42;
    return {
      live,
      duration: 4 + random() * 6,
      delay: -random() * 10,
      level: random() < 0.25 ? 1 : 0.55,
      still: live && random() < 0.3
    };
  });
</script>

<div class="greeting-tiles" style:--cols={COLS} style:--rows={ROWS} aria-hidden="true">
  {#each tiles as tile, index (index)}
    {#if tile.live}
      <span class="cell" class:is-still={tile.still} style="--d:{tile.duration}s;--delay:{tile.delay}s;--level:{tile.level}"></span>
    {:else}
      <span></span>
    {/if}
  {/each}
</div>

<style>
  .greeting-tiles {
    --cell: 0.875rem;
    position: absolute;
    z-index: -1;
    left: 50%;
    top: calc(50% - 1.25rem);
    display: grid;
    grid-template-columns: repeat(var(--cols), var(--cell));
    grid-template-rows: repeat(var(--rows), var(--cell));
    place-items: center;
    transform: translate(-50%, -50%);
    pointer-events: none;
    /* Quiet in the middle where the words are, brightest in a ring around
       them, gone at the edges. */
    mask-image: radial-gradient(closest-side, rgb(0 0 0 / 0.25) 20%, #000 55%, transparent);
    -webkit-mask-image: radial-gradient(closest-side, rgb(0 0 0 / 0.25) 20%, #000 55%, transparent);
  }

  .cell {
    width: calc(var(--cell) * 0.6);
    aspect-ratio: 1;
    border-radius: calc(var(--tile-radius, 0.2) * 100%);
    background: color-mix(in oklab, rgb(var(--tile-hi)) 85%, rgb(var(--tile-accent)));
    opacity: 0;
    animation: greeting-twinkle var(--d) steps(1, end) infinite;
    animation-delay: var(--delay);
  }

  /* Hard steps like the rest of the mosaic: dark, dim, lit, dim, dark. */
  @keyframes greeting-twinkle {
    0%, 59.9% { opacity: 0; }
    60%, 71.9% { opacity: calc(var(--level) * 0.4); }
    72%, 87.9% { opacity: calc(var(--level) * 0.8); }
    88%, 100% { opacity: calc(var(--level) * 0.35); }
  }

  @media (prefers-reduced-motion: reduce) {
    .cell { animation: none; }
    .cell.is-still { opacity: calc(var(--level) * 0.45); }
  }
</style>
