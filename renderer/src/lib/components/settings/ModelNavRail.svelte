<svelte:options runes={true} />

<!--
  Models rail: full-height nav for the Models section.
  Owns folder/import actions; auto-load preference flows via props
  so ModelWorkspace stays in sync.
-->

<script lang="ts">
  import { Box, Compass, FolderInput, FolderOpen, Layers, Upload } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { importLocalModel } from '$lib/services/models';
  import { openModelsFolder, pickModelFile } from '$lib/services/files';
  import type { ModelHubTab } from '$lib/types/model-hub';

  let {
    tab,
    autoLoad,
    onselecttab,
    onautoload
  }: {
    tab: ModelHubTab;
    autoLoad: boolean;
    onselecttab: (tab: ModelHubTab) => void;
    onautoload: (value: boolean) => void;
  } = $props();

  const items = [
    { id: 'discover' as ModelHubTab, label: 'Explore', icon: Compass },
    { id: 'library' as ModelHubTab, label: 'Library', icon: Layers },
    { id: 'active' as ModelHubTab, label: 'Loaded Instances', icon: Box }
  ];

  let importing = $state(false);

  async function importModel() {
    if (importing) return;
    importing = true;
    try {
      const path = await pickModelFile();
      if (!path) return;
      await importLocalModel(path, false);
      await Promise.all([modelsStore.refreshIndex(), appStore.refreshModels()]);
      toastStore.success('Model imported');
    } catch (error) {
      toastStore.error(`Import failed: ${(error as Error)?.message || error}`);
    } finally {
      importing = false;
    }
  }
</script>

<aside class="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--border-subtle)] p-2 pt-4" aria-label="Local models">
  <nav class="flex flex-col gap-0.5" aria-label="Model sections">
    {#each items as item (item.id)}
      {@const Icon = item.icon}
      <button
        type="button"
        class={`flex items-center gap-2 rounded-full px-2.5 py-1.5 text-left text-[13px] font-medium transition ${tab === item.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
        aria-current={tab === item.id ? 'page' : undefined}
        onclick={() => onselecttab(item.id)}
      >
        <Icon class="size-4 shrink-0" />
        <span class="truncate">{item.label}</span>
      </button>
    {/each}
  </nav>
  <div class="mt-auto space-y-0.5 px-1 pb-1 pt-3">
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-full px-2.5 py-1.5 text-left text-[13px] font-medium text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
      onclick={() => void openModelsFolder()}
    >
      <FolderOpen class="size-4 shrink-0" />
      <span class="truncate">Open folder</span>
    </button>
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-full px-2.5 py-1.5 text-left text-[13px] font-medium text-muted-foreground transition hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
      onclick={() => void importModel()}
      disabled={importing}
    >
      <FolderInput class="size-4 shrink-0" />
      <span class="truncate">{importing ? 'Importing…' : 'Import model'}</span>
    </button>
    <button
      type="button"
      class="auto-load-toggle flex w-full items-center justify-center gap-1.5 rounded-full px-2 py-1.5 text-[11px] transition"
      class:is-on={autoLoad}
      onclick={() => onautoload(!autoLoad)}
      aria-pressed={autoLoad}
      title="When on, new downloads load automatically once complete"
    >
      <Upload class="size-3.5 shrink-0" />
      Auto-load
    </button>
  </div>
</aside>

<style>
  .auto-load-toggle {
    color: var(--muted-foreground);
    background: transparent;
  }
  .auto-load-toggle:hover {
    color: var(--foreground);
    background: var(--muted);
  }
  .auto-load-toggle.is-on {
    color: var(--primary-foreground);
    background: var(--primary);
  }
</style>
