<svelte:options runes={true} />

<!--
  The one bottom toolbar every composer draws (Home, Code, Design), so the
  eye finds the same thing in the same place: attach and mode on the left,
  status, model, microphone, context ring and send / stop on the right.
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
    microphone: Snippet;
    context?: Snippet;
    trailing: Snippet;
  }

  let { attach, model, extras, status, microphone, context, trailing }: Props = $props();
</script>

<div class="composer-bar">
  <div class="composer-bar-leading">
    {@render attach?.()}
    {#if attach && extras}<span class="composer-divider" aria-hidden="true"></span>{/if}
    {@render extras?.()}
  </div>
  <div class="composer-bar-trailing">
    {#if model || status}<div class="composer-bar-model">
    {#if status}
      {@render status()}
      <span class="composer-divider" aria-hidden="true"></span>
    {/if}
    {#if model}<div class="model-slot">{@render model()}</div>{/if}
    </div>{/if}
    <div class="composer-bar-actions">
    {@render microphone()}
    {#if context}<span class="composer-divider" aria-hidden="true"></span>{/if}
    {@render context?.()}
    {@render trailing()}
    </div>
  </div>
</div>
