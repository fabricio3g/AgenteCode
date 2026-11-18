<svelte:options runes={true} />

<!--
  One space, kept mounted while another is shown. Hidden is `display: none`
  plus `inert`, so nothing in it paints, takes focus or hears a click, and its
  children learn through `spaceVisible()` that they are off screen. Nested
  layers combine: a layer is visible only when its parent is.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { provideSpaceVisible, spaceVisible } from './space-visibility';

  let { name, visible, children }: { name: string; visible: boolean; children: Snippet } = $props();

  const parent = spaceVisible();
  provideSpaceVisible(() => visible && parent());
</script>

<div class="space-layer" data-space-layer={name} hidden={!visible} inert={!visible}>{@render children()}</div>

<style>
  .space-layer { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; }
  .space-layer[hidden] { display: none; }
</style>
