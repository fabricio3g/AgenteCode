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

<div class={`flex items-center rounded-xl border border-[var(--border)] bg-[var(--surface-highlight)] p-1 ${compact ? 'gap-1' : 'gap-1.5'}`}>
  <button
    class={`flex items-center rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${appStore.workspaceMode === 'legacy' ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm' : 'text-[var(--text-tertiary)] hover:text-[var(--text)]'}`}
    onclick={() => select('legacy')}
    aria-pressed={appStore.workspaceMode === 'legacy'}
    title="Full legacy workspace with complete feature parity"
  >
    <PanelsTopLeft class="mr-1.5 h-3.5 w-3.5" />
    {compact ? 'Full' : 'Full Workspace'}
  </button>

  <button
    class={`flex items-center rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${appStore.workspaceMode === 'modern' ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm' : 'text-[var(--text-tertiary)] hover:text-[var(--text)]'}`}
    onclick={() => select('modern')}
    aria-pressed={appStore.workspaceMode === 'modern'}
    title="Native Svelte workspace"
  >
    <MonitorCog class="mr-1.5 h-3.5 w-3.5" />
    {compact ? 'Svelte' : 'Svelte Workspace'}
  </button>
</div>
