<svelte:options runes={true} />

  <script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';

  const space = $derived(appStore.activeSpace);
  const isWork = $derived(space === 'work');
</script>

<div class="hero-empty flex h-full flex-col items-center justify-center px-6 text-center">
  <div class="flex max-w-md flex-col items-center gap-2">
    <h1 class="text-2xl font-semibold tracking-tight text-foreground">
      {isWork ? 'Start with your files' : 'Start anywhere'}
    </h1>
    <p class="hero-copy text-sm leading-relaxed text-muted-foreground">
      {#if isWork}
        Attach a folder, then ask Flaxeo to explore, explain, or create from it.
      {:else}
        Ask a question or describe what you want to accomplish. Flaxeo can use live data and the web when useful.
      {/if}
    </p>
  </div>
</div>

<style>
  .hero-empty {
    min-height: 100%;
  }

</style>
