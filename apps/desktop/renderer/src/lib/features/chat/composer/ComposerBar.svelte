<svelte:options runes={true} />

<!--
  The one bottom toolbar every composer draws (Home, Code, Design, Bots), so the
  eye finds the same thing in the same place: attach hard left, the model pill
  beside it, one slot for what only this space has (Home's Agent | Instant,
  Code's mode menu), and the trailing cluster (mic, send / stop) hard right.
  A composer that has no attach button or no extras leaves that snippet out; the
  slot is never filled with something else.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    attach?: Snippet;
    model: Snippet;
    extras?: Snippet;
    trailing: Snippet;
  }

  let { attach, model, extras, trailing }: Props = $props();
</script>

<div class="composer-bar">
  <div class="composer-bar-leading">
    {@render attach?.()}
    <div class="model-slot">{@render model()}</div>
    {@render extras?.()}
  </div>
  <div class="composer-bar-trailing">{@render trailing()}</div>
</div>
