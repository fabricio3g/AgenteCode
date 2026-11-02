<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import type { DesignScene } from '$shared/design-3d';
  let { data, scene }: { data: string; scene?: DesignScene } = $props();
  let host: HTMLDivElement;
  let error = $state('');
  let viewer = $state<{ fit(): void; dispose(): void } | undefined>();
  $effect(() => {
    const input = data, element = host, names = scene?.objects.filter(object => object.type !== 'plane').map(object => object.id) ?? [];
    if (!element || !input) return;
    let disposed = false;
    let mounted: typeof viewer;
    error = '';
    void import('./design-model-viewer').then(module => module.mountModelViewer(element, input, names)).then(result => {
      if (disposed) result.dispose(); else { mounted = result; viewer = result; }
    }).catch(reason => { if (!disposed) error = `3D preview unavailable: ${String(reason)}. The render and Blender project are still available.`; });
    return () => { disposed = true; mounted?.dispose(); viewer = undefined; };
  });
</script>

<div class="model-preview">
  <!-- Interactive WebGL surface; OrbitControls handles keyboard panning. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="model-host" bind:this={host} tabindex="0" role="application" aria-label="3D model. Drag to orbit, scroll to zoom, right drag or arrow keys to pan."></div>
  {#if error}<p class="preview-error" role="status">{error}</p>{/if}
  <div class="model-hint"><span>Drag to orbit · Scroll to zoom</span><Button variant="plain" type="button" onclick={() => viewer?.fit()}>Fit model</Button></div>
</div>

<style>
  .model-preview { position: relative; width: 100%; height: 100%; min-height: 10rem; }
  .model-host { width: 100%; height: 100%; outline-offset: -3px; }
  .model-host :global(canvas) { display: block; max-width: 100%; }
  .model-hint { position: absolute; bottom: .75rem; left: .75rem; right: .75rem; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; justify-content: space-between; font-size: var(--text-xs); color: var(--muted-foreground); pointer-events: none; }
  .model-hint :global(button) { pointer-events: auto; padding: .35rem .6rem; border-radius: .4rem; background: var(--background); color: var(--foreground); }
  .preview-error { position: absolute; inset: 20% 1rem auto; font-size: var(--text-sm); color: var(--muted-foreground); }
</style>
