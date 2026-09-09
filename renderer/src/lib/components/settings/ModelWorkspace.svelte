<svelte:options runes={true} />

<!--
  The Models workspace — one surface for the whole local-model lifecycle.

  Three panes, in the order work actually flows:
  - Discover: Hugging Face search plus hardware-picked recommendations, with
    per-quantization fit badges and memory estimates before any byte moves.
  - Library: what is on disk. Downloads render inline on their rows —
    progress, speed, pause/resume — never in a separate modal.
  - Active: the loaded model, its live load phases, and the unload control.

  "Download & load" is an opt-in per download; the choice is remembered and
  becomes the primary action until changed back.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import {
    AlertCircle, BadgeCheck, Ban, Cpu, Download, HardDrive,
    LoaderCircle, MemoryStick, Star, Trash2,
  } from 'lucide-svelte';
  import { Badge, Button, Select } from '$lib/components/ui';
  import { compactCount, quantFromFilename, relativeDate, repoSummaryLine } from '$lib/models/model-explore';
  import ModelSearchField from './ModelSearchField.svelte';
  import ModelDownloadRow from './ModelDownloadRow.svelte';
  import { CURATED_MODELS, defaultArtifact } from '$lib/models/curated-models';
  import { assessModelFit, recommendCuratedModels } from '$lib/models/model-fit';
  import { runtimeCapabilitiesFromInstallations } from '$lib/models/runtime-capabilities';
  import { appStore } from '$lib/stores/app.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { startDownloadHf } from '$lib/services/downloads';
  import { deleteLocalModel, getModelsDirPath } from '$lib/services/models';
  import { getInstalledRuntimes } from '$lib/services/files';
  import { hfRepoGguf, searchHfModelsPage, fetchHfReadme, openWebviewer, type HfGgufFile, type HfModelSearchItem } from '$lib/services/search';
  import ModelDetailPanel, { type ModelDetail } from './ModelDetailPanel.svelte';
  import { isElectron } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { motionFade } from '$lib/utils/transitions';
  import { formatBytes as formatSizeBytes } from '$lib/utils/format';
  import type {
    CuratedModelDefinition, ModelArtifact, ModelFitAssessment, ModelHubTab,
    RuntimeCapabilities,
  } from '$lib/types/model-hub';

  let { tab = $bindable<ModelHubTab>('discover'), autoLoad = $bindable(false) } = $props<{
    tab?: ModelHubTab;
    autoLoad?: boolean;
  }>();

  let localQuery = $state('');
  let localSort = $state<'name' | 'size' | 'modified' | 'state'>('name');
  let runtimeCapabilities = $state<RuntimeCapabilities | null>(null);

  let searchQuery = $state('');
  let searchSort = $state<'likes' | 'downloads' | 'lastModified'>('likes');
  let parameterFilter = $state<'all' | 'small' | 'medium' | 'large'>('all');
  let searchItems = $state<HfModelSearchItem[]>([]);
  let nextCursor = $state<string | null>(null);
  let searchLoading = $state(false);
  let searchLoadingMore = $state(false);
  let searchError = $state('');
  let requestSequence = 0;
  let selectedRepoId = $state<string | null>(null);
  let detailFilename = $state('');
  let readmeByRepo = $state<Record<string, string>>({});
  let readmeLoading = $state<Record<string, boolean>>({});
  let repoMeta = $state<Record<string, { license?: string }>>({});
  let staffOnly = $state(false);
  let repoFiles = $state<Record<string, HfGgufFile[]>>({});
  let repoErrors = $state<Record<string, string>>({});

  const recommendations = $derived(recommendCuratedModels(hardwareStore.info, runtimeCapabilities));

  // Rail tab switches clear the detail selection.
  $effect(() => {
    void tab;
    selectedRepoId = null;
  });
  const recommendationCards = $derived([
    { label: 'Fastest', model: recommendations.fastest },
    { label: 'Best balance', model: recommendations.balance },
    { label: 'Best quality', model: recommendations.quality },
  ]);
  const totalDiskBytes = $derived(
    modelsStore.availableModels.reduce((total, model) => total + Number(model.size_gb || 0) * 1024 ** 3, 0),
  );
  /** Live downloads lead the Library pane — they are the work in flight. */
  const activeJobs = $derived(downloadsStore.jobs.filter((job) =>
    ['queued', 'running', 'paused', 'interrupted'].includes(job.status)
  ));
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
  /** Staff-pick repos resolve against curated GGUF repos. */
  const staffPickRepos = $derived(
    new Set(CURATED_MODELS.filter((m) => m.staffPick).map((m) => m.ggufRepository))
  );
  const visibleCuratedModels = $derived(
    staffOnly ? CURATED_MODELS.filter((m) => m.staffPick) : CURATED_MODELS
  );

  function selectRepo(repoId: string) {
    selectedRepoId = selectedRepoId === repoId ? null : repoId;
    if (selectedRepoId && !repoFiles[repoId]) void ensureRepoFiles(repoId);
  }

  /** Local download matching a repo, via the on-disk directory fragment. */
  function downloadedForRepo(repoId: string) {
    const fragment = repoId.replace('/', '_');
    return modelsStore.availableModels.find((m) => String(m.path || '').includes(fragment)) || null;
  }

  const detailData = $derived.by((): ModelDetail | null => {
    const repoId = selectedRepoId;
    if (!repoId || tab !== 'discover') return null;
    const curated = CURATED_MODELS.find((m) => m.ggufRepository === repoId);
    const item = searchItems.find((entry) => entry.repo_id === repoId);
    if (!curated && !item) return null;
    const downloaded = downloadedForRepo(repoId);
    const readme = readmeByRepo[repoId] ?? '';
    const loading = !!readmeLoading[repoId];

    if (curated) {
      const files = curated.artifacts.map((variant) => {
        const fit = fitForCurated(curated, variant);
        return {
          filename: variant.filename,
          sizeHuman: formatBytes(variant.sizeBytes),
          quantization: variant.quantization,
          fitLabel: fitLabel(fit),
          fitTone: fitTone(fit),
          warn: fit.status === 'constrained' || fit.status === 'unlikely'
        };
      });
      return {
        title: curated.name,
        repoId: curated.ggufRepository,
        author: curated.upstreamRepository.split('/')[0] || '',
        downloads: '',
        likes: '',
        updated: '',
        staffPick: !!curated.staffPick,
        gated: curated.access === 'gated',
        license: curated.license,
        params: `${curated.parametersB}B`,
        architecture: curated.architecture,
        formats: curated.projectorRequired ? ['GGUF', 'Projector'] : ['GGUF'],
        capabilities: [...curated.capabilities],
        summary: curated.role,
        files,
        readme,
        readmeLoading: loading,
        error: '',
        downloadedName: downloaded?.name || null,
        loaded: downloaded ? isLoaded(downloaded) : false
      };
    }

    const entry = item!;
    const flags = entry as unknown as Record<string, unknown>;
    const capabilities: string[] = [];
    if (flags['has_vision']) capabilities.push('Vision');
    if (flags['has_tools']) capabilities.push('Tools');
    const files = (repoFiles[repoId] || []).map((file) => {
      const fit = fitForFile(file);
      return {
        filename: file.filename,
        sizeHuman: file.size_human || formatBytes(Number(file.size || 0)),
        quantization: file.quantization || quantFromFilename(file.filename) || 'GGUF',
        fitLabel: fitLabel(fit),
        fitTone: fitTone(fit),
        warn: fit.status === 'constrained' || fit.status === 'unlikely'
      };
    });
    return {
      title: entry.label || repoId,
      repoId,
      author: entry.author || repoId.split('/')[0] || '',
      downloads: compactCount(entry.downloads),
      likes: compactCount(entry.likes),
      updated: relativeDate(entry.lastModified),
      staffPick: staffPickRepos.has(repoId),
      gated: !!entry.gated,
      license: repoMeta[repoId]?.license || '',
      params: entry.size_label || '',
      architecture: '',
      formats: ['GGUF'],
      capabilities,
      summary: repoSummaryLine(entry),
      files,
      readme,
      readmeLoading: loading,
      error: repoErrors[repoId] || '',
      downloadedName: downloaded?.name || null,
      loaded: downloaded ? isLoaded(downloaded) : false
    };
  });

  async function downloadDetailFile(filename: string, loadWhenReady: boolean) {
    const repoId = selectedRepoId;
    if (!repoId) return;
    const curated = CURATED_MODELS.find((m) => m.ggufRepository === repoId);
    if (curated) {
      const variant = curated.artifacts.find((a) => a.filename === filename);
      if (!variant) return;
      await downloadArtifact(repoId, variant, fitForCurated(curated, variant), loadWhenReady);
      return;
    }
    const file = (repoFiles[repoId] || []).find((f) => f.filename === filename);
    if (!file) return;
    await downloadArtifact(repoId, file, fitForFile(file), loadWhenReady);
  }

  async function useDetailInChat() {
    const repoId = selectedRepoId;
    if (!repoId) return;
    const downloaded = downloadedForRepo(repoId);
    if (!downloaded) return;
    await appStore.openLocalModelLoadDialog(downloaded);
  }

  async function openDetailWeb() {
    const repoId = selectedRepoId;
    if (!repoId) return;
    const title = detailData?.title || repoId;
    await openWebviewer(`https://huggingface.co/${repoId}`, title).catch(() => {});
  }

  $effect(() => {
    const repoId = selectedRepoId;
    if (!repoId || tab !== 'discover') return;
    if (readmeByRepo[repoId] !== undefined || readmeLoading[repoId]) return;
    readmeLoading = { ...readmeLoading, [repoId]: true };
    void fetchHfReadme(repoId).then((res) => {
      readmeByRepo = { ...readmeByRepo, [repoId]: res.readme };
      readmeLoading = { ...readmeLoading, [repoId]: false };
    });
  });

  const supervisor = $derived(modelsStore.status);
  const activeModelName = $derived(supervisor?.active_model || '');
  const loadPhase = $derived(supervisor?.load_phase || '');
  const loadProgress = $derived(Number(supervisor?.load_progress ?? 0));

  /** Canonical byte formatting, with this panel's wording for an unknown size. */
  function formatBytes(bytes: number): string {
    return formatSizeBytes(bytes, 'Size unavailable');
  }

  /** Remembered "Download & load" choice — owned by the modal rail, bound here. */
  function setAutoLoadPreferred(value: boolean) {
    autoLoad = value;
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

  function fitTone(fit: ModelFitAssessment): 'success' | 'warning' | 'error' | 'neutral' {
    if (fit.status === 'excellent' || fit.status === 'good') return 'success';
    if (fit.status === 'constrained') return 'warning';
    if (fit.status === 'unlikely') return 'error';
    return 'neutral';
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

  async function downloadArtifact(repoId: string, artifact: ModelArtifact | HfGgufFile, fit: ModelFitAssessment, loadWhenReady = false) {
    const filename = artifact.filename;
    const existing = downloadsStore.jobFor(repoId, filename);
    if (existing && ['queued', 'running', 'paused'].includes(existing.status)) {
      toastStore.info('This artifact is already downloading.');
      return;
    }
    if (['constrained', 'unlikely'].includes(fit.status)) {
      const accepted = window.confirm(`${fit.reason}\n\nDownload ${filename} anyway?`);
      if (!accepted) return;
    }
    try {
      const modelsDir = await getModelsDirPath();
      await startDownloadHf({
        repo_id: repoId,
        file: filename,
        models_dir: modelsDir,
        dest_rel: `${repoId.replace('/', '_')}/${filename}`,
        load_when_ready: loadWhenReady
      });
      downloadsStore.startPolling();
      await downloadsStore.refresh();
      toastStore.success(loadWhenReady
        ? `Downloading ${filename}. It will load automatically when ready.`
        : `Downloading ${filename}.`);
    } catch (error) {
      toastStore.error(`Download failed: ${(error as Error)?.message || error}`);
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

  /** Load GGUF file list for the detail panel. No inline expansion anymore. */
  async function ensureRepoFiles(repoId: string) {
    if (repoFiles[repoId]) return;
    repoErrors = { ...repoErrors, [repoId]: '' };
    try {
      const payload = await hfRepoGguf(repoId);
      if (!payload) throw new Error('Repository response was empty or malformed.');
      if (payload.error) throw new Error(payload.error);
      const files = Array.isArray(payload.gguf_files) ? payload.gguf_files : [];
      repoFiles = { ...repoFiles, [repoId]: files };
      if (payload.license) repoMeta = { ...repoMeta, [repoId]: { license: String(payload.license) } };
      if (!files.length) repoErrors = { ...repoErrors, [repoId]: 'No downloadable GGUF artifacts were found in this repository.' };
    } catch (error) {
      repoErrors = { ...repoErrors, [repoId]: String((error as Error)?.message || error) };
    }
  }

  $effect(() => {
    if (tab !== 'discover') return;
    searchQuery;
    searchSort;
    parameterFilter;
    const timer = setTimeout(() => void runSearch(), 320);
    return () => clearTimeout(timer);
  });

  onMount(() => {
    downloadsStore.startPolling();
    if (isElectron()) {
      void Promise.all([modelsStore.refresh(), hardwareStore.refresh(), downloadsStore.refresh()]);
      void getInstalledRuntimes()
        .then((result) => { runtimeCapabilities = runtimeCapabilitiesFromInstallations(result.runtimes); })
        .catch(() => { runtimeCapabilities = null; });
    }
  });
</script>

<div class="flex min-h-0 flex-1 flex-col bg-[var(--background)]">
  <div class="flex min-h-0 flex-1 overflow-hidden">
    <div class="min-h-0 min-w-0 flex-1 overflow-y-auto">
    {#key tab}
    <div
      id={`model-hub-sections-panel-${tab}`}
      role="tabpanel"
      aria-labelledby={`model-hub-sections-tab-${tab}`}
      class={`space-y-4 p-4 sm:p-5 ${tab === 'discover' && detailData ? 'mx-auto max-w-[1200px]' : 'mx-auto max-w-[940px]'}`}
      in:motionFade={{ duration: 120 }}
    >
      {#if tab === 'discover'}
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem]">
            <ModelSearchField
              class="col-span-2 sm:col-span-1"
              bind:value={searchQuery}
              placeholder="Search GGUF models on Hugging Face…"
              label="Search GGUF models"
            />
            <Select
              bind:value={searchSort}
              class="h-9 text-xs"
              aria-label="Sort search results"
              options={[
                { value: 'likes', label: 'Most liked' },
                { value: 'downloads', label: 'Downloads' },
                { value: 'lastModified', label: 'Newest' },
              ]}
            />
            <Select
              bind:value={parameterFilter}
              class="h-9 text-xs"
              aria-label="Parameter size"
              options={[
                { value: 'all', label: 'Any size' },
                { value: 'small', label: 'Under 5B' },
                { value: 'medium', label: '5B–14B' },
                { value: 'large', label: 'Over 14B' },
              ]}
            />
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition ${staffOnly ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
              aria-pressed={staffOnly}
              onclick={() => (staffOnly = !staffOnly)}
            >
              <Star class="size-3.5" />
              Staff picks
            </button>
          </div>

          {#if searchError}
            <div class="flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-error">
              <AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{searchError}</span>
            </div>
          {/if}

          <div class="flex flex-col items-start gap-4 xl:flex-row">
            <div class="min-w-0 flex-1 space-y-4 self-stretch">
          {#if searchLoading}
            <div class="flex justify-center py-10"><LoaderCircle class="h-5 w-5 animate-spin" /></div>
          {:else if filteredSearchItems.length === 0}
            <!-- Calm default while the query is empty: hardware picks instead of an empty wall. -->
            <section class="space-y-2" aria-label="Recommended for your hardware">
              <p class="text-[11px] font-semibold text-muted-foreground">Picked for your hardware</p>
              <div class="grid gap-2 sm:grid-cols-3">
                {#each recommendationCards as recommendation}
                  <div class="rounded-xl bg-card p-3 shadow-[inset_0_0_0_1px_var(--border)]">
                    <p class="text-[10px] font-semibold text-muted-foreground">{recommendation.label}</p>
                    <p class="mt-1 text-sm font-semibold text-foreground">
                      {recommendation.model?.name || (recommendation.label === 'Best balance' ? recommendations.defaultModel.name : 'Hardware needed')}
                    </p>
                  </div>
                {/each}
              </div>
              {#if !hardwareStore.info}
                <p class="rounded-xl bg-muted/50 px-3 py-2 text-xs text-fg-secondary">
                  Hardware is not available, so estimates are neutral.
                </p>
              {/if}
            </section>

            <section class="space-y-2" aria-label="Curated model catalog">
              <p class="text-[11px] font-semibold text-muted-foreground">{staffOnly ? 'Staff picks' : 'Curated'}</p>
              {#each visibleCuratedModels as model (model.id)}
                {@const primary = defaultArtifact(model)}
                {@const fit = fitForCurated(model, primary)}
                {@const job = downloadsStore.jobFor(model.ggufRepository, primary.filename)}
                <article class={`rounded-xl transition-colors ${selectedRepoId === model.ggufRepository ? 'bg-muted text-foreground shadow-[inset_0_0_0_1px_var(--border)]' : 'hover:bg-muted/60'}`}>
                  <div class="flex items-center gap-3 p-3">
                    <button
                      type="button"
                      class="min-w-0 flex-1 text-left"
                      onclick={() => {
                        selectedRepoId = selectedRepoId === model.ggufRepository ? null : model.ggufRepository;
                      }}
                    >
                      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 class="text-sm font-semibold text-foreground">{model.name}</h3>
                        {#if model.staffPick}<Badge tone="neutral" class="shrink-0">Staff pick</Badge>{/if}
                        <span class="text-xs text-muted-foreground">{model.parametersB}B · {model.role}</span>
                      </div>
                      <p class="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground" title={fit.reason}>
                        <Badge tone={fitTone(fit)}>{fitLabel(fit)}</Badge>
                        <span class="tabular-nums">{primary.quantization} · {formatBytes(primary.sizeBytes)} · ~{formatBytes(fit.estimatedWorkingMemoryBytes)}</span>
                      </p>
                    </button>
                    <div class="flex shrink-0 items-center gap-2">
                      {#if job && ['queued', 'running', 'paused'].includes(job.status)}
                        <span class="text-xs tabular-nums text-muted-foreground">{Math.round(job.progress)}%</span>
                        <Button variant="ghost" size="icon-sm" aria-label="Cancel download" onclick={() => void downloadsStore.cancelJob(job.id)}><Ban /></Button>
                      {:else}
                        <Button
                          size="sm"
                          class="text-xs"
                          onclick={() => downloadArtifact(model.ggufRepository, primary, fit, autoLoad)}
                        ><Download />{autoLoad ? 'Download & load' : 'Download'}</Button>
                      {/if}
                    </div>
                  </div>
                </article>
              {/each}
            </section>
          {:else}
            <section class="space-y-1">
              {#each filteredSearchItems as item (item.repo_id)}
                <article class={`rounded-xl transition-colors ${selectedRepoId === item.repo_id ? 'bg-muted text-foreground shadow-[inset_0_0_0_1px_var(--border)]' : 'hover:bg-muted/60'}`}>
                  <button
                    class="flex w-full items-center gap-3 rounded-xl p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/25"
                    onclick={() => selectRepo(item.repo_id)}
                  >
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1.5">
                        <h3 class="truncate text-sm font-semibold text-foreground">{item.label || item.repo_id}</h3>
                        {#if staffPickRepos.has(item.repo_id)}<Badge tone="neutral" class="shrink-0">Staff pick</Badge>{/if}
                      </div>
                      <p class="mt-1 truncate text-xs font-medium text-foreground">{repoSummaryLine(item) || item.repo_id}</p>
                      <p class="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {item.author || item.repo_id.split('/')[0]} · {compactCount(item.likes)} likes · {compactCount(item.downloads)} downloads{#if relativeDate(item.lastModified)} · {relativeDate(item.lastModified)}{/if}
                      </p>
                    </div>
                    {#if item.gated}<Badge tone="warning" class="shrink-0">Gated</Badge>{/if}
                  </button>
                </article>
              {/each}
              {#if nextCursor}
                <Button variant="ghost" class="w-full text-xs" disabled={searchLoadingMore} onclick={() => runSearch(nextCursor)}>
                  {#if searchLoadingMore}<LoaderCircle class="mr-1 inline h-3.5 w-3.5 animate-spin" />{/if}Load more
                </Button>
              {/if}
            </section>
          {/if}
            </div>
            {#if detailData}
              <div class="w-full shrink-0 xl:sticky xl:top-0 xl:w-[360px]">
                <ModelDetailPanel
                  detail={detailData}
                  selectedFilename={detailFilename}
                  onselectfile={(next) => (detailFilename = next)}
                  ondownload={(filename) => void downloadDetailFile(filename, false)}
                  ondownloadload={(filename) => void downloadDetailFile(filename, true)}
                  onuseinchat={() => void useDetailInChat()}
                  onunload={() => void appStore.stopLocalModel()}
                  onopenweb={() => void openDetailWeb()}
                  onclose={() => (selectedRepoId = null)}
                />
              </div>
            {/if}
          </div>

      {:else if tab === 'library'}
        {#if activeJobs.length}
          <section class="space-y-2" aria-label="Active downloads">
            <p class="text-[11px] font-semibold text-muted-foreground">Downloading</p>
            {#each activeJobs as job (job.id)}
              <ModelDownloadRow {job} compact={false} />
            {/each}
          </section>
        {/if}

        <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
          <ModelSearchField
            class="flex-1"
            bind:value={localQuery}
            placeholder="Filter library…"
            label="Filter downloaded models"
            clearLabel="Clear downloaded model filter"
          />
          <Select
            bind:value={localSort}
            class="h-9 w-full text-xs sm:w-36"
            aria-label="Sort downloaded models"
            options={[
              { value: 'name', label: 'Name' },
              { value: 'size', label: 'Size' },
              { value: 'modified', label: 'Modified' },
              { value: 'state', label: 'Load state' },
            ]}
          />
        </div>
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <HardDrive class="h-3.5 w-3.5" />
          {modelsStore.availableModels.length} models · {formatBytes(totalDiskBytes)}
        </div>
        {#if modelsStore.loading}
          <div class="flex justify-center py-12"><LoaderCircle class="h-5 w-5 animate-spin" /></div>
        {:else if downloadedModels.length === 0}
          <div class="rounded-xl border border-[var(--border-subtle)] bg-card p-10 text-center text-sm text-muted-foreground">
            Nothing here yet — discover a model to get started.
          </div>
        {:else}
          <section class="space-y-1">
            {#each downloadedModels as model (model.id)}
              {@const fit = fitForLocal(model)}
              {@const loaded = isLoaded(model)}
              <article class="flex flex-col gap-3 rounded-xl p-3 transition-colors hover:bg-muted/60 sm:flex-row sm:items-center">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <h3 class="truncate text-sm font-semibold text-foreground">{model.name}</h3>
                    {#if loaded}
                      <Badge tone="success" class="shrink-0">Loaded</Badge>
                    {/if}
                  </div>
                  <p class="mt-1 truncate text-xs text-fg-secondary">{model.architecture || 'Unknown architecture'} · {model.quantization_name || 'Unknown quant'} · {formatBytes(Number(model.size_gb || 0) * 1024 ** 3)}</p>
                  <p class="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground" title={fit.reason}>
                    <Badge tone={fitTone(fit)}>{fitLabel(fit)}</Badge>
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  {#if loaded}
                    <Button variant="ghost" size="sm" class="text-xs" onclick={() => appStore.stopLocalModel()}>Unload</Button>
                  {:else}
                    <Button size="sm" class="text-xs" onclick={() => appStore.openLocalModelLoadDialog(model)}>Load</Button>
                  {/if}
                  <Button variant="ghost" size="icon-sm" class="text-error" aria-label={`Delete ${model.name}`} onclick={() => removeModel(model)}><Trash2 /></Button>
                </div>
              </article>
            {/each}
          </section>
        {/if}

      {:else}
        <!-- Active: the loaded model and its live load phases. -->
        {#if !activeModelName && !loadPhase}
          <div class="rounded-xl border border-[var(--border-subtle)] bg-card p-10 text-center">
            <p class="text-sm font-semibold text-foreground">No model loaded</p>
            <p class="mt-1 text-xs text-muted-foreground">Load one from the Library, or download a new one.</p>
            <Button variant="ghost" size="sm" class="mx-auto mt-3 text-xs" onclick={() => (tab = 'library')}>Go to Library</Button>
          </div>
        {:else}
          <section class="space-y-3 rounded-xl bg-card p-4 shadow-[inset_0_0_0_1px_var(--border)]">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-[11px] font-semibold text-muted-foreground">Loaded model</p>
                <h3 class="truncate text-base font-semibold text-foreground">{activeModelName || 'Starting…'}</h3>
              </div>
              <Button variant="ghost" size="sm" class="shrink-0 text-xs" onclick={() => appStore.stopLocalModel()}>Unload</Button>
            </div>

            {#if loadPhase || (loadProgress > 0 && loadProgress < 100)}
              <div>
                <div class="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{loadPhase || 'Preparing…'}</span>
                  <span class="tabular-nums">{Math.round(loadProgress)}%</span>
                </div>
                <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                  <div class="h-full rounded-full bg-foreground transition-[width] duration-500 ease-out" style={`width: ${Math.max(4, loadProgress)}%`}></div>
                </div>
              </div>
            {/if}

            {#if hardwareStore.info}
              <div class="grid grid-cols-2 gap-2 pt-1 text-xs text-fg-secondary">
                <div class="flex items-center gap-1.5"><MemoryStick class="h-3.5 w-3.5 text-muted-foreground" /> RAM {Number(hardwareStore.info.free_ram_gb || 0).toFixed(1)} GB free of {Number(hardwareStore.info.total_ram_gb || 0).toFixed(0)} GB</div>
                <div class="flex items-center gap-1.5"><Cpu class="h-3.5 w-3.5 text-muted-foreground" /> VRAM {Number(hardwareStore.info.vram_gb || 0).toFixed(1)} GB{hardwareStore.info.gpu_name ? ` · ${hardwareStore.info.gpu_name}` : ''}</div>
              </div>
            {/if}
          </section>
        {/if}
      {/if}
    </div>
    {/key}
    </div>
  </div>
</div>

