<svelte:options runes={true} />

<!--
  Minimal 2×2 micro-matrix activity indicator (Law of Prägnanz: half the visual
  noise of the old 2×4 rain, aligned cleanly with 12–13px UI text).

  · `busy`      smooth clockwise pulse while events are arriving
  · `quiet`     slow, gentle breath when a tool is waiting
  · `attention` steady amber pulse until you answer an approval
  · `stopped`   neutral dim still frame while the engine unwinds

  An optional `color` tints the matrix for task-specific activity lines.
  Decorative (`aria-hidden="true"`). Under reduced motion the base styles hold
  a clean two-tile diagonal still.
-->

<script lang="ts">
  import type { TileMeterMode } from '$lib/utils/activity-meter';

  let { mode = 'quiet', color = '' }: { mode?: TileMeterMode; color?: string } = $props();

  /** Clockwise order across the 2×2 grid: top-left → top-right → bottom-right → bottom-left. */
  const PHASES = [0, 1, 3, 2];
</script>

<span
  class="tile-rain"
  class:is-busy={mode === 'busy'}
  class:is-attention={mode === 'attention'}
  class:is-stopped={mode === 'stopped'}
  class:is-tinted={!!color}
  style={color ? `--rain-color: ${color}` : ''}
  aria-hidden="true"
>
  {#each PHASES as phase (phase)}
    <span class="tile" style="--p:{phase}"></span>
  {/each}
</span>
