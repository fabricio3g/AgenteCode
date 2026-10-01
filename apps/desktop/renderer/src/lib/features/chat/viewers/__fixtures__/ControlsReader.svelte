<script lang="ts">
  import { registerViewerControls, useViewerControls } from '../viewer-controls.svelte';
  let { paged }: { paged: boolean } = $props();
  let page = $state(1);
  let zoom = $state(1);
  const controls = useViewerControls()!;
  registerViewerControls(controls, () => paged ? {
    page, pages: 12, goToPage: next => { page = next; }, zoom: `${zoom}`, zoomBy: direction => { zoom += direction; }, fit: () => { zoom = 1; }, search: { matches: controls.query ? 2 : 0, index: 0 }
  } : {});
</script>
<div>{page} · {zoom}</div>
