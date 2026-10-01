<script lang="ts">
  import { createViewerControls, provideViewerControls, viewerShortcuts } from '../viewer-controls.svelte';
  import ControlsReader from './ControlsReader.svelte';
  import ViewerToolbar from '../ViewerToolbar.svelte';
  let { paged = true, name = 'Reader' }: { paged?: boolean; name?: string } = $props();
  const controls = createViewerControls();
  provideViewerControls(controls);
</script>
<div data-reader={name} use:viewerShortcuts={controls}>
  <ViewerToolbar title={name} />
  {#key paged}<ControlsReader {paged} />{/key}
</div>
