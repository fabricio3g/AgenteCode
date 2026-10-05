<svelte:options runes={true} />

<!--
  How alive a run is, told as weather: two columns of tiles that drops step
  through, drawn in the landing page's mosaic — six levels, hard steps, no
  fades (`tile-rain` in app.css carries the paint and the keyframe).

  · `busy`     a drop every 0.31s a cell, while events are arriving
  · `quiet`    the same rain at a quarter speed, so a stalled tool looks stalled
  · `attention` the rain stops mid-fall and the square turns amber, blinking
                until you answer an approval
  · `stopped`  the reader asked to stop: the rain freezes on the still frame
                while the engine unwinds, so a stopped run stops looking busy

  Decorative: the row's own label says what is happening, so this stays out of
  the accessibility tree. Under reduced motion the base styles hold a designed
  still — a drizzle frozen mid-fall, not a frozen animation.
-->

<script lang="ts">
  type Mode = 'busy' | 'quiet' | 'attention' | 'stopped';

  let { mode = 'quiet' }: { mode?: Mode } = $props();

  /**
   * All eight tiles take the same five-step trip (dark → dim → trail → head →
   * dark); only the phase differs, so one keyframe serves every tile. A phase
   * is the tile's delay in cell-crossing units: as long as the cycle, minus
   * how long the drop takes to reach this cell — three cells after the head
   * passes, and half a cycle later in the right column, so the two columns
   * never fall in lockstep.
   */
  const PHASES = [-3.8, -6.3, -2.8, -5.3, -1.8, -4.3, -0.8, -3.3];
</script>

<span
  class="tile-rain"
  class:is-busy={mode === 'busy'}
  class:is-attention={mode === 'attention'}
  class:is-stopped={mode === 'stopped'}
  aria-hidden="true"
>
  {#each PHASES as phase (phase)}
    <span class="tile" style="--p:{phase}"></span>
  {/each}
</span>
