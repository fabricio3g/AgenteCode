<svelte:options runes={true} />

<script lang="ts">
  import { MonitorCog, PanelsTopLeft } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';

  interface Props {
    compact?: boolean;
  }

  let { compact = false }: Props = $props();

  function select(mode: 'legacy' | 'modern') {
    void appStore.setWorkspaceMode(mode);
  }
</script>

<div class="aui-segmented {compact ? '' : ''}">
  <button
    type="button"
    class="aui-segmented-item flex items-center gap-1.5 px-2.5 py-1.5 {appStore.workspaceMode === 'legacy' ? 'is-active' : ''}"
    onclick={() => select('legacy')}
    aria-pressed={appStore.workspaceMode === 'legacy'}
    title="Full legacy workspace with complete feature parity"
  >
    <PanelsTopLeft class="size-3.5" />
    {compact ? 'Full' : 'Full Workspace'}
  </button>

  <button
    type="button"
    class="aui-segmented-item flex items-center gap-1.5 px-2.5 py-1.5 {appStore.workspaceMode === 'modern' ? 'is-active' : ''}"
    onclick={() => select('modern')}
    aria-pressed={appStore.workspaceMode === 'modern'}
    title="Native Svelte workspace"
  >
    <MonitorCog class="size-3.5" />
    {compact ? 'Svelte' : 'Svelte Workspace'}
  </button>
</div>
