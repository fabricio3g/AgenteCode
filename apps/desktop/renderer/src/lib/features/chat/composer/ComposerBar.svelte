<svelte:options runes={true} />

<!--
  The one bottom toolbar every composer draws (Home, Code, Design), so the
  eye finds the same thing in the same place: attach and mode on the left,
  status, model, microphone and send / stop on the right.
  A composer that has no attach button or no extras leaves that snippet out; the
  slot is never filled with something else.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    attach?: Snippet;
    model?: Snippet;
    extras?: Snippet;
    status?: Snippet;
    microphone?: Snippet;
    trailing?: Snippet;
  }

  let { attach, model, extras, status, microphone, trailing }: Props = $props();
</script>

<div class="composer-bar">
  <div class="composer-bar-leading">
    {@render attach?.()}
    {@render extras?.()}
  </div>
  <div class="composer-bar-trailing">
    {#if model || status}<div class="composer-bar-model">
    {#if status}
      {@render status()}
    {/if}
    {#if model}<div class="model-slot">{@render model()}</div>{/if}
    </div>{/if}
    {#if microphone || trailing}<div class="composer-bar-actions">
    {@render microphone?.()}
    {@render trailing?.()}
    </div>{/if}
  </div>
</div>
