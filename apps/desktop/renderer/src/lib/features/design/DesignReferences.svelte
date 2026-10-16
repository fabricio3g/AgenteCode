<svelte:options runes={true} />

<!--
  The images the design must match, as one quiet row of thumbnails above the
  composer. Each has a × to take it off; the agent is told to match whatever is
  here (agent-design-runtime). Renders nothing when there are none. Images are
  added from the dock's Reference menu, by dropping on the canvas, or by pasting
  while no field has focus.
-->

<script lang="ts">
  import { X } from 'lucide-svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { copy } from '$lib/copy';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { designStore } from './design.svelte';
  import { referenceLabel } from './design-references';

  async function remove(path: string) {
    try { await designStore.removeReference(path); } catch (error) { toastStore.error(error instanceof Error ? error.message : String(error)); }
  }
</script>

{#if designStore.references.length}
  <div class="refs" role="list" aria-label={copy.design.references.tray}>
    {#each designStore.references as item (item.path)}
      <div class="ref" role="listitem" title={referenceLabel(item.path)}>
        {#if item.src}<img src={item.src} alt={referenceLabel(item.path)} draggable="false" />{/if}
        <IconButton label={copy.design.references.remove} size="xs" class="remove" title="" onclick={() => void remove(item.path)}><X aria-hidden="true" /></IconButton>
      </div>
    {/each}
  </div>
{/if}

<style>
  .refs {
    display: flex;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem 0;
    overflow-x: auto;
  }

  .ref {
    position: relative;
    flex-shrink: 0;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--radius-md);
    background: var(--muted);
    overflow: hidden;
  }

  .ref img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* The × shows on hover or focus, so a resting row is only pictures. */
  .ref :global(.remove) {
    position: absolute;
    top: 0.0625rem;
    right: 0.0625rem;
    opacity: 0;
    background: color-mix(in srgb, var(--background) 80%, transparent);
    transition: opacity var(--motion-instant) var(--motion-ease);
  }
  .ref:hover :global(.remove),
  .ref :global(.remove:focus-visible) { opacity: 1; }
</style>
