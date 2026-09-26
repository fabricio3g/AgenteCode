<svelte:options runes={true} />

<!--
  Models rail: full-height nav for the Models section.
  Owns folder/import actions; auto-load preference flows via props
  so ModelWorkspace stays in sync.
-->

<script lang="ts">
  import { Box, Compass, FolderInput, FolderOpen, Layers } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { Switch } from '$lib/components/ui';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
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

  const activeDownloads = $derived(downloadsStore.jobs.filter((job) => ['queued', 'running'].includes(job.status)).length);
  const items = $derived([
    { id: 'discover' as ModelHubTab, label: $t('modelHub.navExplore'), icon: Compass, count: 0, dot: false },
    { id: 'library' as ModelHubTab, label: $t('modelHub.navLibrary'), icon: Layers, count: activeDownloads, dot: false },
    { id: 'active' as ModelHubTab, label: $t('modelHub.navRunning'), icon: Box, count: 0, dot: !!modelsStore.status?.active_model }
  ]);

  let importing = $state(false);

  async function importModel() {
    if (importing) return;
    importing = true;
    try {
      const path = await pickModelFile();
      if (!path) return;
      await importLocalModel(path, false);
      await Promise.all([modelsStore.refreshIndex(), appStore.refreshModels()]);
      toastStore.success(get(t)('modelHub.imported'));
    } catch (error) {
      toastStore.error(get(t)('modelHub.importFailed', { values: { reason: (error as Error)?.message || String(error) } }));
    } finally {
      importing = false;
    }
  }
</script>

<aside class="flex shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--border)] px-3 py-5 md:w-[220px]" aria-label={$t('modelHub.navLabel')}>
  <p class="px-2.5 pb-3 text-[15px] font-semibold tracking-[-0.01em] text-foreground">{$t('modelHub.navTitle')}</p>
  <nav class="flex flex-col gap-1" aria-label={$t('modelHub.navLabel')}>
    {#each items as item (item.id)}
      {@const Icon = item.icon}
      <button
        type="button"
        class={`nav-row flex items-center gap-2.5 ${tab === item.id ? 'is-active' : ''}`}
        aria-current={tab === item.id ? 'page' : undefined}
        onclick={() => onselecttab(item.id)}
      >
        <Icon class="size-4 shrink-0" />
        <span class="min-w-0 flex-1 truncate">{item.label}</span>
        {#if item.count}<span class="rounded-full bg-primary px-1.5 text-[10px] font-semibold tabular-nums text-primary-fg">{item.count}</span>{/if}
        {#if item.dot}<span class="size-1.5 shrink-0 rounded-full bg-[var(--success)]"></span>{/if}
      </button>
    {/each}
  </nav>

  <div class="mt-auto space-y-0.5 border-t border-[var(--border)] pt-3">
    <button
      type="button"
      class="nav-row flex w-full items-center gap-2.5 font-normal"
      onclick={() => void openModelsFolder()}
    >
      <FolderOpen class="size-4 shrink-0" />
      <span class="truncate">{$t('modelHub.openFolder')}</span>
    </button>
    <button
      type="button"
      class="nav-row flex w-full items-center gap-2.5 font-normal disabled:opacity-50"
      onclick={() => void importModel()}
      disabled={importing}
    >
      <FolderInput class="size-4 shrink-0" />
      <span class="truncate">{importing ? $t('modelHub.importing') : $t('modelHub.importModel')}</span>
    </button>
    <div class="flex items-center justify-between gap-2 px-2.5 py-1.5" title={$t('modelHub.autoLoadHint')}>
      <span class="text-[12px] text-muted-foreground">{$t('modelHub.autoLoad')}</span>
      <Switch label={$t('modelHub.autoLoad')} checked={autoLoad} onchange={(next) => onautoload(next)} />
    </div>
  </div>
</aside>
