<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import {
    AlertCircle, Ban, ChevronDown, Download, FolderInput, FolderOpen, HardDrive,
    LoaderCircle, Trash2,
  } from 'lucide-svelte';
  import { Badge, Button, SegmentedControl, Select } from '$lib/components/ui';
  import ModelSearchField from './ModelSearchField.svelte';
  import { CURATED_MODELS, defaultArtifact } from '$lib/models/curated-models';
  import { assessModelFit, recommendCuratedModels } from '$lib/models/model-fit';
  import { runtimeCapabilitiesFromInstallations } from '$lib/models/runtime-capabilities';
  import { appStore } from '$lib/stores/app.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { startDownloadHf, cancelDownloadJob } from '$lib/services/downloads';
  import { deleteLocalModel, getModelsDirPath, importLocalModel } from '$lib/services/models';
  import { getInstalledRuntimes, openModelsFolder, pickModelFile } from '$lib/services/files';
  import { hfRepoGguf, searchHfModelsPage, type HfGgufFile, type HfModelSearchItem } from '$lib/services/search';
  import { isTauri } from '$lib/services/tauri';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { motionFade } from '$lib/utils/transitions';
  import type {
    CuratedModelDefinition, ModelArtifact, ModelFitAssessment, ModelHubTab,
    RuntimeCapabilities,
  } from '$lib/types/model-hub';

  let { tab = $bindable<ModelHubTab>('curated') } = $props<{ tab?: ModelHubTab }>();

  let localQuery = $state('');
  let localSort = $state<'name' | 'size' | 'modified' | 'state'>('name');
  let importing = $state(false);
  let curatedExpanded = $state<Record<string, boolean>>({});
  let runtimeCapabilities = $state<RuntimeCapabilities | null>(null);

  let searchQuery = $state('');
  let searchSort = $state<'likes' | 'downloads' | 'lastModified'>('likes');
  let parameterFilter = $state<'all' | 'small' | 'medium' | 'large'>('all');
  let ggufOnly = $state(true);
  let searchItems = $state<HfModelSearchItem[]>([]);
  let nextCursor = $state<string | null>(null);
  let searchLoading = $state(false);
  let searchLoadingMore = $state(false);
  let searchError = $state('');
  let requestSequence = 0;
  let expandedRepos = $state<Record<string, boolean>>({});
  let repoFiles = $state<Record<string, HfGgufFile[]>>({});
  let repoErrors = $state<Record<string, string>>({});
  let selectedFiles = $state<Record<string, string>>({});

  const recommendations = $derived(recommendCuratedModels(hardwareStore.info, runtimeCapabilities));
  const recommendationCards = $derived([
    { label: 'Fastest', model: recommendations.fastest },
    { label: 'Best balance', model: recommendations.balance },
    { label: 'Best quality', model: recommendations.quality },
  ]);
  const totalDiskBytes = $derived(
    modelsStore.availableModels.reduce((total, model) => total + Number(model.size_gb || 0) * 1024 ** 3, 0),
  );
  const downloadedModels = $derived.by(() => {
    const query = localQuery.trim().toLowerCase();
    const models = modelsStore.availableModels.filter((model) =>
      !query || `${model.name} ${model.path} ${model.architecture || ''} ${model.quantization_name || ''}`.toLowerCase().includes(query)
    );
    return [...models].sort((left, right) => {
      if (localSort === 'size') return Number(right.size_gb || 0) - Number(left.size_gb || 0);
      if (localSort === 'modified') return Number(right.modified || 0) - Number(left.modified || 0);
      if (localSort === 'state') return Number(isLoaded(right)) - Number(isLoaded(left));
      return String(left.name).localeCompare(String(right.name));
    });
  });
  const filteredSearchItems = $derived(searchItems.filter(matchesParameterFilter));

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Size unavailable';
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 2 : 1)} GB`;
  }

  function fitForCurated(model: CuratedModelDefinition, artifact = defaultArtifact(model)): ModelFitAssessment {
    return assessModelFit({
      artifact,
      parametersB: model.parametersB,
      architecture: model.architecture,
      hardware: hardwareStore.info,
      runtime: runtimeCapabilities,
      requirement: model.runtime,
    });
  }

  function fitForLocal(model: { size_gb?: number; parameter_count?: number; architecture?: string }): ModelFitAssessment {
    return assessModelFit({
      artifact: { sizeBytes: Number(model.size_gb || 0) * 1024 ** 3 },
      parametersB: Number(model.parameter_count || 0) / 1e9,
      architecture: model.architecture,
      hardware: hardwareStore.info,
    });
  }

  function fitForFile(file: HfGgufFile): ModelFitAssessment {
    return assessModelFit({
      artifact: { sizeBytes: Number(file.size || 0) },
      hardware: hardwareStore.info,
    });
  }

  function fitLabel(fit: ModelFitAssessment): string {
    return ({
      excellent: 'Excellent fit',
      good: 'Good fit',
      constrained: 'Constrained',
      unlikely: 'Unlikely to fit',
      runtime_update: 'Runtime update',
      unknown: 'Fit unknown',
    } as const)[fit.status];
  }

  function isLoaded(model: { id?: string; name?: string; path?: string }): boolean {
    const active = String(appStore.localModelActive?.path || appStore.localModelActive?.name || '').toLowerCase();
    return Boolean(active) && [model.id, model.name, model.path]
      .filter(Boolean)
      .some((value) => active.includes(String(value).toLowerCase()) || String(value).toLowerCase().includes(active));
  }

  function matchesParameterFilter(item: HfModelSearchItem): boolean {
    if (parameterFilter === 'all') return true;
    const text = `${item.repo_id} ${item.label || ''} ${item.size_label || ''}`;
    const match = text.match(/(?:^|[-_\s])(\d+(?:\.\d+)?)\s*b(?:[-_\s]|$)/i);
    if (!match) return true;
    const parameters = Number(match[1]);
    if (parameterFilter === 'small') return parameters < 5;
    if (parameterFilter === 'medium') return parameters >= 5 && parameters <= 14;
    return parameters > 14;
  }

  async function downloadArtifact(repoId: string, artifact: ModelArtifact | HfGgufFile, fit: ModelFitAssessment) {
    const filename = artifact.filename;
    const existing = downloadsStore.jobFor(repoId, filename);
    if (existing && ['starting', 'running'].includes(existing.status)) {
      toastStore.info('This artifact is already downloading.');
      return;
    }
    if (['constrained', 'unlikely'].includes(fit.status)) {
      const accepted = window.confirm(`${fit.reason}\n\nDownload ${filename} anyway? Downloading will not load the model.`);
      if (!accepted) return;
    }
    try {
      const modelsDir = await getModelsDirPath();
      await startDownloadHf({
        repo_id: repoId,
        file: filename,
        models_dir: modelsDir,
        dest_rel: `${repoId.replace('/', '_')}/${filename}`,
      });
      downloadsStore.startPolling();
      await downloadsStore.refresh();
      toastStore.success(`Downloading ${filename}. It will not be loaded automatically.`);
    } catch (error) {
      toastStore.error(`Download failed: ${(error as Error)?.message || error}`);
    }
  }

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

  async function removeModel(model: { name: string; path: string }) {
    if (!window.confirm(`Delete ${model.name} from disk? This cannot be undone.`)) return;
    try {
      await deleteLocalModel(model.path);
      await Promise.all([modelsStore.refreshIndex(), appStore.refreshModels()]);
      toastStore.success('Model deleted');
    } catch (error) {
      toastStore.error(`Delete failed: ${(error as Error)?.message || error}`);
    }
  }

  async function runSearch(cursor: string | null = null) {
    const sequence = ++requestSequence;
    const loadingMore = Boolean(cursor);
    if (loadingMore) searchLoadingMore = true;
    else {
      searchLoading = true;
      searchError = '';
    }
    try {
      const page = await searchHfModelsPage(searchQuery.trim(), searchSort, 20, cursor);
      if (sequence !== requestSequence) return;
      if (page.error) searchError = page.error;
      searchItems = loadingMore ? [...searchItems, ...page.items] : page.items;
      nextCursor = page.nextCursor;
    } catch (error) {
      if (sequence === requestSequence) {
        searchError = String((error as Error)?.message || error || 'Search failed.');
        if (!loadingMore) searchItems = [];
      }
    } finally {
      if (sequence === requestSequence) {
        searchLoading = false;
        searchLoadingMore = false;
      }
    }
  }

  async function toggleRepo(repoId: string) {
    const opening = !expandedRepos[repoId];
    expandedRepos = { ...expandedRepos, [repoId]: opening };
    if (!opening || repoFiles[repoId]) return;
    repoErrors = { ...repoErrors, [repoId]: '' };
    try {
      const payload = await hfRepoGguf(repoId);
      if (!payload) throw new Error('Repository response was empty or malformed.');
      if (payload.error) throw new Error(payload.error);
      const files = Array.isArray(payload.gguf_files) ? payload.gguf_files : [];
      repoFiles = { ...repoFiles, [repoId]: files };
      selectedFiles = { ...selectedFiles, [repoId]: files[0]?.filename || '' };
      if (!files.length) repoErrors = { ...repoErrors, [repoId]: 'No downloadable GGUF artifacts were found in this repository.' };
    } catch (error) {
      repoErrors = { ...repoErrors, [repoId]: String((error as Error)?.message || error) };
    }
  }

  $effect(() => {
    if (tab !== 'search') return;
    searchQuery;
    searchSort;
    parameterFilter;
    ggufOnly;
    const timer = setTimeout(() => void runSearch(), 320);
    return () => clearTimeout(timer);
  });

  onMount(() => {
    downloadsStore.startPolling();
    if (isTauri()) {
      void Promise.all([modelsStore.refresh(), hardwareStore.refresh(), downloadsStore.refresh()]);
      void getInstalledRuntimes()
        .then((result) => { runtimeCapabilities = runtimeCapabilitiesFromInstallations(result.runtimes); })
        .catch(() => { runtimeCapabilities = null; });
    }
  });
</script>

<div class="flex min-h-0 flex-1 flex-col bg-[var(--background)]">
  <header class="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
    <div>
      <h2 class="text-base font-semibold tracking-[-0.02em] text-[var(--text)]">Local models</h2>
      <p class="text-xs text-[var(--text-muted)]">Reviewed downloads, your complete library, and Hugging Face discovery.</p>
    </div>
    <SegmentedControl
      id="model-hub-sections"
      label="Model hub sections"
      variant="tabs"
      value={tab}
      options={[
        { value: 'curated', label: 'Curated' },
        { value: 'downloaded', label: 'Downloaded' },
        { value: 'search', label: 'Search' },
      ]}
      onchange={(value) => (tab = value as ModelHubTab)}
    />
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#key tab}
    <div
      id={`model-hub-sections-panel-${tab}`}
      role="tabpanel"
      aria-labelledby={`model-hub-sections-tab-${tab}`}
      class="mx-auto max-w-[940px] space-y-4 p-4 sm:p-5"
      in:motionFade={{ duration: 120 }}
    >
      {#if tab === 'curated'}
        <section class="grid gap-2 sm:grid-cols-3" aria-label="Hardware recommendations">
          {#each recommendationCards as recommendation}
            <div class="rounded-lg bg-[var(--surface)] p-3 transition-colors hover:bg-[var(--surface-hover)]">
              <p class="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{recommendation.label}</p>
              <p class="mt-1 text-sm font-semibold text-[var(--text)]">
                {recommendation.model?.name || (recommendation.label === 'Best balance' ? recommendations.defaultModel.name : 'Hardware needed')}
              </p>
            </div>
          {/each}
        </section>
        {#if !hardwareStore.info}
          <p class="rounded-lg bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-secondary)]">
            Hardware is not available, so estimates are neutral. {recommendations.defaultModel.name} is the general default—not a guaranteed fit.
          </p>
        {/if}

        <section class="space-y-2" aria-label="Curated model catalog">
          {#each CURATED_MODELS as model (model.id)}
            {@const primary = defaultArtifact(model)}
            {@const fit = fitForCurated(model, primary)}
            {@const job = downloadsStore.jobFor(model.ggufRepository, primary.filename)}
            <article class={`rounded-lg transition-colors ${curatedExpanded[model.id] ? 'bg-[var(--surface-active)]' : 'bg-[var(--surface)] hover:bg-[var(--surface-hover)]'}`}>
              <div class="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 class="text-sm font-semibold text-[var(--text)]">{model.name}</h3>
                    <span class="text-xs text-[var(--text-muted)]">{model.parametersB}B · {model.role}</span>
                  </div>
                  <p class="mt-1 text-xs text-[var(--text-secondary)]">
                    {model.capabilities.join(' · ')} · {model.license} · {primary.quantization} · {formatBytes(primary.sizeBytes)}
                  </p>
                  <p class="mt-1 text-[11px] text-[var(--text-muted)]" title={fit.reason}>
                    {fitLabel(fit)} · ~{formatBytes(fit.estimatedWorkingMemoryBytes)} working memory (estimate)
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  {#if job && ['starting', 'running'].includes(job.status)}
                    <span class="text-xs tabular-nums text-[var(--text-muted)]">{Math.round(job.progress)}%</span>
                    <Button variant="ghost" size="icon-sm" aria-label="Cancel download" onclick={async () => { await cancelDownloadJob(job.id); await downloadsStore.refresh(); }}><Ban /></Button>
                  {:else}
                    <Button
                      size="sm"
                      class="text-xs"
                      onclick={() => downloadArtifact(model.ggufRepository, primary, fit)}
                    ><Download />Download</Button>
                  {/if}
                  <Button variant="ghost" size="icon-sm" aria-label={`Show variants for ${model.name}`} aria-expanded={!!curatedExpanded[model.id]} onclick={() => (curatedExpanded = { ...curatedExpanded, [model.id]: !curatedExpanded[model.id] })}>
                    <ChevronDown class={`h-4 w-4 transition-transform ${curatedExpanded[model.id] ? 'rotate-180' : ''}`} />
                  </Button>
                </div>
              </div>
              {#if curatedExpanded[model.id]}
                <div class="rounded-b-lg bg-[var(--background)] px-3 py-2">
                  {#each model.artifacts as variant (variant.filename)}
                    {@const variantFit = fitForCurated(model, variant)}
                    <div class="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                      <div class="min-w-0">
                        <p class="truncate text-xs font-medium text-[var(--text)]">{variant.quantization} · {formatBytes(variant.sizeBytes)}</p>
                        <p class="truncate text-[11px] text-[var(--text-muted)]">{fitLabel(variantFit)} · {variant.filename}</p>
                      </div>
                      <Button variant="ghost" size="sm" class="shrink-0 text-xs" onclick={() => downloadArtifact(model.ggufRepository, variant, variantFit)}>Download</Button>
                    </div>
                  {/each}
                </div>
              {/if}
            </article>
          {/each}
        </section>

      {:else if tab === 'downloaded'}
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
          <ModelSearchField
            class="flex-1"
            bind:value={localQuery}
            placeholder="Filter downloaded models…"
            label="Filter downloaded models"
            clearLabel="Clear downloaded model filter"
          />
          <Select
            variant="surface"
            bind:value={localSort}
            class="h-11 w-full text-xs sm:w-36"
            aria-label="Sort downloaded models"
            options={[
              { value: 'name', label: 'Name' },
              { value: 'size', label: 'Size' },
              { value: 'modified', label: 'Modified' },
              { value: 'state', label: 'Load state' },
            ]}
          />
          <div class="flex items-center gap-1">
            <Button variant="ghost" size="sm" class="text-xs" onclick={importModel} disabled={importing}><FolderInput />Import</Button>
            <Button variant="ghost" size="sm" class="text-xs" onclick={openModelsFolder}><FolderOpen />Open folder</Button>
          </div>
        </div>
        <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <HardDrive class="h-3.5 w-3.5" />
          {modelsStore.availableModels.length} models · {formatBytes(totalDiskBytes)}
        </div>
        {#if modelsStore.loading}
          <div class="flex justify-center py-12"><LoaderCircle class="h-5 w-5 animate-spin" /></div>
        {:else if downloadedModels.length === 0}
          <div class="rounded-lg bg-[var(--surface)] p-10 text-center text-sm text-[var(--text-muted)]">No downloaded models match this filter.</div>
        {:else}
          <section class="space-y-2">
            {#each downloadedModels as model (model.id)}
              {@const fit = fitForLocal(model)}
              <article class="flex flex-col gap-3 rounded-lg bg-[var(--surface)] p-3 transition-colors hover:bg-[var(--surface-hover)] sm:flex-row sm:items-center">
                <div class="min-w-0 flex-1">
                  <h3 class="truncate text-sm font-semibold text-[var(--text)]">{model.name}</h3>
                  <p class="mt-1 truncate text-xs text-[var(--text-secondary)]">{model.architecture || 'Unknown architecture'} · {model.quantization_name || 'Unknown quant'} · {formatBytes(Number(model.size_gb || 0) * 1024 ** 3)}</p>
                  <p class="mt-1 text-[11px] text-[var(--text-muted)]">{fitLabel(fit)} · {fit.reason}</p>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  {#if isLoaded(model)}
                    <Button variant="ghost" size="sm" class="text-xs" onclick={() => appStore.stopLocalModel()}>Unload</Button>
                  {:else}
                    <Button size="sm" class="text-xs" onclick={() => appStore.openLocalModelLoadDialog(model)}>Load</Button>
                  {/if}
                  <Button variant="ghost" size="icon-sm" class="text-[var(--danger)]" aria-label={`Delete ${model.name}`} onclick={() => removeModel(model)}><Trash2 /></Button>
                </div>
              </article>
            {/each}
          </section>
        {/if}

      {:else}
        <div class="flex flex-col gap-3">
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem]">
            <ModelSearchField
              class="col-span-2 sm:col-span-1"
              bind:value={searchQuery}
              placeholder="Search GGUF models…"
              label="Search GGUF models"
            />
            <Select
              variant="surface"
              bind:value={searchSort}
              class="h-11 text-xs"
              aria-label="Sort search results"
              options={[
                { value: 'likes', label: 'Most liked' },
                { value: 'downloads', label: 'Downloads' },
                { value: 'lastModified', label: 'Newest' },
              ]}
            />
            <Select
              variant="surface"
              bind:value={parameterFilter}
              class="h-11 text-xs"
              aria-label="Parameter size"
              options={[
                { value: 'all', label: 'Any size' },
                { value: 'small', label: 'Under 5B' },
                { value: 'medium', label: '5B–14B' },
                { value: 'large', label: 'Over 14B' },
              ]}
            />
          </div>
          <div><Badge class="border-0 bg-[var(--card)] px-2.5 py-1 text-[var(--text-secondary)]">GGUF only</Badge></div>
        </div>
        {#if searchError}
          <div class="flex items-start gap-2 rounded-lg bg-[var(--surface)] px-3 py-2 text-xs text-[var(--danger)]">
            <AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{searchError}</span>
          </div>
        {/if}
        {#if searchLoading}
          <div class="flex justify-center py-12"><LoaderCircle class="h-5 w-5 animate-spin" /></div>
        {:else if filteredSearchItems.length === 0}
          <div class="rounded-lg bg-[var(--surface)] p-10 text-center">
            <p class="text-sm font-semibold text-[var(--text)]">No GGUF models found</p>
            <p class="mt-1 text-xs text-[var(--text-muted)]">Try a broader model name or parameter range.</p>
          </div>
        {:else}
          <section class="space-y-2">
            {#each filteredSearchItems as item (item.repo_id)}
              <article class={`rounded-lg transition-colors ${expandedRepos[item.repo_id] ? 'bg-[var(--surface-active)]' : 'bg-[var(--surface)] hover:bg-[var(--surface-hover)]'}`}>
                <button
                  class="flex w-full items-center gap-3 rounded-lg p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/25"
                  onclick={() => toggleRepo(item.repo_id)}
                  aria-expanded={!!expandedRepos[item.repo_id]}
                >
                  <div class="min-w-0 flex-1">
                    <h3 class="truncate text-sm font-semibold text-[var(--text)]">{item.label || item.repo_id}</h3>
                    <p class="mt-1 truncate text-xs text-[var(--text-muted)]">{item.author || item.repo_id.split('/')[0]} · {Number(item.likes || 0).toLocaleString()} likes · {Number(item.downloads || 0).toLocaleString()} downloads</p>
                  </div>
                  {#if item.gated}<span class="text-[10px] font-semibold text-[var(--warning)]">Token/license required</span>{/if}
                  <ChevronDown class={`h-4 w-4 transition-transform ${expandedRepos[item.repo_id] ? 'rotate-180' : ''}`} />
                </button>
                {#if expandedRepos[item.repo_id]}
                  <div class="rounded-b-lg bg-[var(--background)] p-3">
                    {#if repoErrors[item.repo_id]}
                      <div class="flex items-start gap-2 rounded-md bg-[var(--surface)] px-3 py-2 text-xs text-[var(--danger)]">
                        <AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>{repoErrors[item.repo_id]}</span>
                      </div>
                    {:else if !repoFiles[item.repo_id]}
                      <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]"><LoaderCircle class="h-3.5 w-3.5 animate-spin" />Loading artifacts…</div>
                    {:else}
                      <div class="space-y-2">
                        {#each repoFiles[item.repo_id] as file (file.filename)}
                          {@const fit = fitForFile(file)}
                          {@const job = downloadsStore.jobFor(item.repo_id, file.filename)}
                          <div class="flex flex-col gap-2 rounded-md bg-[var(--background)] px-3 py-2 sm:flex-row sm:items-center">
                            <div class="min-w-0 flex-1">
                              <p class="truncate text-xs font-medium text-[var(--text)]">{file.filename}</p>
                              <p class="text-[11px] text-[var(--text-muted)]">{file.size_human || formatBytes(Number(file.size || 0))} · {fitLabel(fit)} · ~{formatBytes(fit.estimatedWorkingMemoryBytes)} working memory</p>
                            </div>
                            {#if job && ['starting', 'running'].includes(job.status)}
                              <span class="text-xs tabular-nums text-[var(--text-muted)]">{Math.round(job.progress)}%</span>
                              <Button variant="ghost" size="icon-sm" aria-label="Cancel download" onclick={async () => { await cancelDownloadJob(job.id); await downloadsStore.refresh(); }}><Ban /></Button>
                            {:else}
                              <Button size="sm" class="text-xs" onclick={() => downloadArtifact(item.repo_id, file, fit)}><Download />Download</Button>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </article>
            {/each}
          </section>
          {#if nextCursor}
            <Button variant="ghost" class="w-full text-xs" disabled={searchLoadingMore} onclick={() => runSearch(nextCursor)}>
              {#if searchLoadingMore}<LoaderCircle class="mr-1 inline h-3.5 w-3.5 animate-spin" />{/if}Load more
            </Button>
          {/if}
        {/if}
      {/if}
    </div>
    {/key}
  </div>
</div>
