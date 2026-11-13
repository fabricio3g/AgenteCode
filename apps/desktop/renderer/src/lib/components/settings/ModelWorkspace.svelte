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
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

  import { copy } from '$lib/copy';
  import { locale, t } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { onMount } from 'svelte';
  import {
    AlertCircle, Ban, Check, ChevronRight, Cpu, Download, FolderInput, FolderOpen, HardDrive,
    LoaderCircle, MemoryStick, Trash2,
  } from '$lib/icons';
  import { Badge, Button, Select, Switch, Tooltip } from '$lib/components/ui';
  import { openModelsFolder, pickModelFile } from '$lib/services/files';
  import { importLocalModel } from '$lib/services/models';
  import { compactCount, quantFromFilename } from '$lib/models/model-explore';
  import ModelSearchField from './ModelSearchField.svelte';
  import ModelDownloadRow from './ModelDownloadRow.svelte';
  import { CURATED_MODELS, MEMORY_TIERS, defaultArtifact, memoryTierOf } from '$lib/models/curated-models';
  import { assessModelFit, recommendCuratedModels } from '$lib/models/model-fit';
  import { runtimeCapabilitiesFromInstallations } from '$lib/models/runtime-capabilities';
  import { appStore } from '$lib/stores/app.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { startDownloadHf } from '$lib/services/downloads';
  import { deleteLocalModel, getModelsDirPath } from '$lib/services/models';
  import { getInstalledRuntimes } from '$lib/services/files';
  import { licenseInfo } from '$lib/models/license';
  import InstancesPanel from './InstancesPanel.svelte';
  import { hfRepoGguf, searchHfModelsPage, fetchHfReadme, openWebviewer, type HfGgufFile, type HfModelSearchItem } from '$lib/services/search';
  import ModelDetailPanel, { type ModelDetail } from './ModelDetailPanel.svelte';
  import { isElectron } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { motionFade } from '$lib/utils/transitions';
  import SettingsPage from './SettingsPage.svelte';
  import SettingsSection from './SettingsSection.svelte';
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
  let repoFiles = $state<Record<string, HfGgufFile[]>>({});
  let repoErrors = $state<Record<string, string>>({});

  const recommendations = $derived(recommendCuratedModels(hardwareStore.info, runtimeCapabilities));

  // Rail tab switches clear the detail selection.
  $effect(() => {
    void tab;
    selectedRepoId = null;
  });
  const recommendationCards = $derived([
    { label: $t('modelHub.fastest'), model: recommendations.fastest },
    { label: $t('modelHub.balance'), model: recommendations.balance ?? recommendations.defaultModel },
    { label: $t('modelHub.quality'), model: recommendations.quality },
  ]);

  /** "3 days ago" / "12 Jun" in the UI language. */
  function relativeDate(input?: string | number | null): string {
    if (input === undefined || input === null || input === '') return '';
    const time = typeof input === 'number' ? input : Date.parse(String(input));
    if (!Number.isFinite(time)) return '';
    const lang = get(locale) || 'en';
    const days = Math.floor((Date.now() - time) / 86_400_000);
    if (days < 30) return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-Math.max(0, days), 'day');
    const sameYear = new Date(time).getFullYear() === new Date().getFullYear();
    return new Date(time).toLocaleDateString(lang, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  }

  function repoSummaryLine(item: HfModelSearchItem): string {
    const files = Array.isArray(item.gguf_files) ? item.gguf_files.length : 0;
    return [
      item.size_label ? String(item.size_label) : '',
      files ? get(t)('modelHub.fileCount', { values: { n: files } }) : ''
    ].filter(Boolean).join(' · ');
  }
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
  /** Only permissive licenses (Apache, MIT, BSD…): what the app prefers. */
  let openLicenseOnly = $state(false);
  const filteredSearchItems = $derived(searchItems.filter((item) => matchesParameterFilter(item) && (!openLicenseOnly || !!licenseInfo(item.license)?.open)));
  /** The curated list grouped by the memory each model needs. */
  const curatedByTier = $derived(
    MEMORY_TIERS.map((tier) => ({ tier, models: CURATED_MODELS.filter((model) => memoryTierOf(model) === tier) }))
      .filter((group) => group.models.length)
  );
  const roleOf = (model: CuratedModelDefinition) => get(t)(`modelHub.role.${model.role}`);

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
        gated: curated.access === 'gated',
        license: curated.license,
        params: `${curated.parametersB}B`,
        architecture: curated.architecture,
        formats: curated.projectorRequired ? ['GGUF', 'Projector'] : ['GGUF'],
        capabilities: curated.capabilities.map((name) => get(t)(`modelHub.cap.${name}`)),
        summary: roleOf(curated),
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
    if (flags['has_vision']) capabilities.push(get(t)('modelHub.capVision'));
    if (flags['has_tools']) capabilities.push(get(t)('modelHub.capTools'));
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
    return formatSizeBytes(bytes, get(t)('modelHub.sizeUnknown'));
  }

  /** Remembered "Download & load" choice: the switch sits on the Explore header. */
  function setAutoLoadPreferred(value: boolean) {
    autoLoad = value;
  }

  let importing = $state(false);

  /** Add a .gguf from anywhere on disk to the library. */
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
    return get(t)(`modelHub.fit.${fit.status}`);
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
      toastStore.info(get(t)('modelHub.alreadyDownloading'));
      return;
    }
    if (['constrained', 'unlikely'].includes(fit.status)) {
      const accepted = await confirmStore.ask({
        title: get(t)('modelHub.downloadAnywayTitle'),
        message: get(t)('modelHub.downloadAnywayMessage', { values: { file: filename, fit: fitLabel(fit) } }),
        confirmLabel: copy.actions.download
      });
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
      toastStore.success(get(t)(loadWhenReady ? 'modelHub.downloadingAndLoad' : 'modelHub.downloading', { values: { file: filename } }));
    } catch (error) {
      toastStore.error(get(t)('modelHub.downloadFailed', { values: { reason: (error as Error)?.message || String(error) } }));
    }
  }

  async function removeModel(model: { name: string; path: string }) {
    const accepted = await confirmStore.ask({
      title: get(t)('modelHub.deleteTitle', { values: { name: model.name } }),
      message: get(t)('modelHub.deleteMessage'),
      details: [model.path],
      confirmLabel: copy.actions.delete,
      danger: true
    });
    if (!accepted) return;
    try {
      await deleteLocalModel(model.path);
      await Promise.all([modelsStore.refreshIndex(), appStore.refreshModels()]);
      toastStore.success(get(t)('modelHub.deleted'));
    } catch (error) {
      toastStore.error(get(t)('modelHub.deleteFailed', { values: { reason: (error as Error)?.message || String(error) } }));
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
        searchError = String((error as Error)?.message || error || get(t)('modelHub.searchFailed'));
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
      if (!payload) throw new Error(get(t)('modelHub.repoEmpty'));
      if (payload.error) throw new Error(payload.error);
      const files = Array.isArray(payload.gguf_files) ? payload.gguf_files : [];
      repoFiles = { ...repoFiles, [repoId]: files };
      if (payload.license) repoMeta = { ...repoMeta, [repoId]: { license: String(payload.license) } };
      if (!files.length) repoErrors = { ...repoErrors, [repoId]: get(t)('modelHub.noGguf') };
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

<!-- A model that runs well says nothing; only a problem earns a word and a colour. -->
{#snippet fitNote(fit: ModelFitAssessment)}
  {#if fitTone(fit) === 'warning' || fitTone(fit) === 'error' || fit.status === 'runtime_update'}
    <span class="fit-note" class:is-error={fitTone(fit) === 'error'} title={fit.reason}>{fitLabel(fit)}</span>
  {/if}
{/snippet}

{#snippet licenseText(raw: string | undefined)}
  {@const info = licenseInfo(raw)}
  {#if info}<span class:license-restricted={info.tone === 'restricted'} title={raw}>{info.label}</span>{/if}
{/snippet}

{#snippet licenseBadge(raw: string | undefined)}
  {@const info = licenseInfo(raw)}
  {#if info}
    <span class="license-badge" class:open={info.tone === 'open'} class:restricted={info.tone === 'restricted'} title={raw}>{info.label}</span>
  {/if}
{/snippet}

{#snippet jobProgress(repoId: string, filename: string)}
  {@const job = downloadsStore.jobFor(repoId, filename)}
  {#if job && ['queued', 'running', 'paused'].includes(job.status)}
    <span class="text-xs tabular-nums text-muted-foreground">{Math.round(job.progress)}%</span>
    <Tooltip label={$t('modelHub.cancelDownload')} position="bottom"><IconButton label={$t('modelHub.cancelDownload')} variant="ghost" size="sm"  onclick={() => void downloadsStore.cancelJob(job.id)}><Ban /></IconButton></Tooltip>
  {/if}
{/snippet}

{#key tab}
  <div class="flex min-h-0 flex-1 flex-col" in:motionFade={{ duration: 120 }}>
    {#if tab === 'discover'}
      <SettingsPage title={$t('modelHub.exploreTitle')} description={$t('modelHub.exploreDescription')} wide={!!detailData}>
        {#snippet actions()}
          <span class="flex items-center gap-2 text-xs text-muted-foreground" title={$t('modelHub.autoLoadHint')}>
            <span aria-hidden="true">{$t('modelHub.autoLoad')}</span>
            <Switch label={$t('modelHub.autoLoad')} checked={autoLoad} onchange={(next) => setAutoLoadPreferred(next)} />
          </span>
        {/snippet}
        <!-- Search, then the filters that refine it -->
        <ModelSearchField
          bind:value={searchQuery}
          placeholder={$t('modelHub.searchPlaceholder')}
          label={$t('modelHub.searchPlaceholder')}
          clearLabel={$t('modelHub.clearSearch')}
        />
        <div class="-mt-2 flex flex-wrap items-center gap-2">
          <Select
            bind:value={searchSort}
            class="w-40"
            size="sm"
            aria-label={$t('modelHub.sort')}
            options={[
              { value: 'likes', label: $t('modelHub.sortLikes') },
              { value: 'downloads', label: $t('modelHub.sortDownloads') },
              { value: 'lastModified', label: $t('modelHub.sortNewest') },
            ]}
          />
          <Select
            bind:value={parameterFilter}
            class="w-40"
            size="sm"
            aria-label={$t('modelHub.size')}
            options={[
              { value: 'all', label: $t('modelHub.sizeAny') },
              { value: 'small', label: $t('modelHub.sizeSmall') },
              { value: 'medium', label: $t('modelHub.sizeMedium') },
              { value: 'large', label: $t('modelHub.sizeLarge') },
            ]}
          />
          <Button variant="outline" size="sm" class={openLicenseOnly ? 'bg-[var(--float-row-hover)] text-foreground' : 'text-muted-foreground'} aria-pressed={openLicenseOnly} onclick={() => (openLicenseOnly = !openLicenseOnly)}>
            {#if openLicenseOnly}<Check />{/if}{$t('modelHub.openLicenseOnly')}
          </Button>
        </div>

        {#if searchError}
          <div class="flex items-start gap-2 rounded-xl bg-error-bg px-3 py-2 text-xs text-error">
            <AlertCircle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{searchError}</span>
          </div>
        {/if}

        <div class="flex flex-col items-start gap-4 xl:flex-row">
          <div class="w-full min-w-0 flex-1 space-y-5">
            {#if searchLoading}
              <div class="flex justify-center py-10"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
            {:else if filteredSearchItems.length === 0}
              <!-- Empty query: hardware picks and the curated list instead of an empty wall. -->
              <SettingsSection title={$t('modelHub.pickedTitle')} description={hardwareStore.info ? $t('modelHub.pickedHint') : $t('modelHub.pickedNoHardware')}>
                <div class="pick-grid">
                  {#each recommendationCards as card (card.label)}
                    <Button variant="plain"
                      type="button"
                      class={uiClass("pick-cell", "ui-local-2f53538a")}
                      disabled={!card.model}
                      onclick={() => card.model && (selectedRepoId = card.model.ggufRepository)}
                    >
                      <p class="text-[length:var(--text-xs)] text-muted-foreground">{card.label}</p>
                      <p class="mt-1 truncate text-sm font-medium text-foreground">{card.model?.name ?? $t('modelHub.nothingFits')}</p>
                      {#if card.model}<p class="truncate text-[length:var(--text-xs)] text-muted-foreground">{roleOf(card.model)} · {formatBytes(defaultArtifact(card.model).sizeBytes)}</p>{/if}
                    </Button>
                  {/each}
                </div>
              </SettingsSection>

              {#each curatedByTier as group (group.tier)}
                <SettingsSection title={$t('modelHub.tierTitle', { values: { gb: group.tier } })} description={$t(`modelHub.tierHint${group.tier}`)} flush>
                  <ul class="px-2 pb-1">
                    {#each group.models as model (model.id)}
                      {@const primary = defaultArtifact(model)}
                      {@const fit = fitForCurated(model, primary)}
                      {@const job = downloadsStore.jobFor(model.ggufRepository, primary.filename)}
                      {@const selected = selectedRepoId === model.ggufRepository}
                      <li class="model-line" class:is-selected={selected}>
                        <Button variant="plain" type="button" class={uiClass("min-w-0 flex-1 text-left", "ui-local-2f53538a")} onclick={() => (selectedRepoId = selected ? null : model.ggufRepository)}>
                          <span class="flex min-w-0 items-baseline gap-2">
                            <span class="shrink-0 text-sm font-medium text-foreground">{model.name}</span>
                            <span class="truncate text-xs text-muted-foreground">{roleOf(model)}</span>
                          </span>
                          <span class="model-meta">
                            <span class="tabular-nums">{primary.quantization} · {formatBytes(primary.sizeBytes)}</span>
                            {#if licenseInfo(model.license)}<span aria-hidden="true">·</span>{@render licenseText(model.license)}{/if}
                            {@render fitNote(fit)}
                          </span>
                        </Button>
                        <div class="flex shrink-0 items-center gap-1">
                          {#if job && ['queued', 'running', 'paused'].includes(job.status)}
                            {@render jobProgress(model.ggufRepository, primary.filename)}
                          {:else if downloadedForRepo(model.ggufRepository)}
                            <span class="row-state"><Check class="size-3.5" />{$t('modelHub.downloaded')}</span>
                          {:else}
                            <Tooltip label={`${$t('modelHub.download')} · ${formatBytes(primary.sizeBytes)}`} position="bottom">
                              <IconButton label={$t('modelHub.download')} variant="ghost" size="sm" onclick={() => downloadArtifact(model.ggufRepository, primary, fit, autoLoad)}><Download /></IconButton>
                            </Tooltip>
                          {/if}
                        </div>
                      </li>
                    {/each}
                  </ul>
                </SettingsSection>
              {/each}
            {:else}
              <SettingsSection title={$t('modelHub.results')} description={$t('modelHub.resultsHint')} flush>
                <ul class="px-2 pb-1">
                  {#each filteredSearchItems as item (item.repo_id)}
                    {@const selected = selectedRepoId === item.repo_id}
                    <li>
                      <Button variant="plain"
                        type="button"
                        class={uiClass(`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/25 ${selected ? 'bg-[var(--surface-active)]' : 'hover:bg-[var(--surface-hover)]'}`, "ui-local-2f53538a")}
                        aria-pressed={selected}
                        onclick={() => selectRepo(item.repo_id)}
                      >
                        <span class="min-w-0 flex-1">
                          <span class="flex items-center gap-1.5">
                            <span class="truncate text-sm font-medium text-foreground">{item.label || item.repo_id}</span>
                            {#if item.gated}<Badge tone="warning" class="shrink-0">{$t('modelHub.gated')}</Badge>{/if}
                            {@render licenseBadge(item.license)}
                          </span>
                          <span class="mt-0.5 block truncate text-[length:var(--text-xs)] text-muted-foreground">
                            {[
                              item.author || item.repo_id.split('/')[0],
                              repoSummaryLine(item),
                              $t('modelHub.likes', { values: { n: compactCount(item.likes) } }),
                              $t('modelHub.downloadsCount', { values: { n: compactCount(item.downloads) } }),
                              relativeDate(item.lastModified)
                            ].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
                      </Button>
                    </li>
                  {/each}
                </ul>
                {#if nextCursor}
                  <div class="px-3 pb-2">
                    <Button variant="ghost" class="w-full text-xs" loading={searchLoadingMore} onclick={() => runSearch(nextCursor)}>{$t('modelHub.loadMore')}</Button>
                  </div>
                {/if}
              </SettingsSection>
            {/if}
          </div>

          {#if detailData}
            <div class="order-first w-full shrink-0 xl:sticky xl:top-0 xl:order-none xl:w-[360px]">
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
      </SettingsPage>

    {:else if tab === 'library'}
      <SettingsPage
        title={$t('modelHub.libraryTitle')}
        description={$t('modelHub.libraryDescription', { values: { n: modelsStore.availableModels.length, size: formatBytes(totalDiskBytes) } })}
      >
        {#snippet actions()}
          <Button variant="outline" size="sm" onclick={() => void openModelsFolder()}><FolderOpen /> {$t('modelHub.openFolder')}</Button>
          <Button variant="outline" size="sm" loading={importing} onclick={() => void importModel()}><FolderInput /> {importing ? $t('modelHub.importing') : $t('modelHub.importModel')}</Button>
        {/snippet}
        {#if activeJobs.length}
          <SettingsSection title={$t('modelHub.downloadingTitle')}>
            {#each activeJobs as job (job.id)}
              <div class="px-4 py-2.5 sm:px-5"><ModelDownloadRow {job} /></div>
            {/each}
          </SettingsSection>
        {/if}

        <div class="flex flex-wrap items-center gap-2">
          <ModelSearchField
            class="min-w-[14rem] flex-1"
            bind:value={localQuery}
            placeholder={$t('modelHub.filterLibrary')}
            label={$t('modelHub.filterLibrary')}
            clearLabel={$t('modelHub.clearSearch')}
          />
          <Select
            bind:value={localSort}
            class="w-36"
            aria-label={$t('modelHub.sort')}
            options={[
              { value: 'name', label: $t('modelHub.sortName') },
              { value: 'size', label: $t('modelHub.sortSize') },
              { value: 'modified', label: $t('modelHub.sortModified') },
              { value: 'state', label: $t('modelHub.sortLoaded') },
            ]}
          />
        </div>

        {#if modelsStore.loading}
          <div class="flex justify-center py-12"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
        {:else if downloadedModels.length === 0}
          <SettingsSection>
            <div class="flex flex-col items-center gap-2 py-8 text-center">
              <HardDrive class="size-5 text-muted-foreground" />
              <p class="text-sm font-medium text-foreground">{localQuery ? $t('modelHub.noLibraryMatches') : $t('modelHub.libraryEmpty')}</p>
              {#if !localQuery}
                <p class="text-xs text-muted-foreground">{$t('modelHub.libraryEmptyHint')}</p>
                <Button variant="outline" size="sm" class="mt-1" onclick={() => (tab = 'discover')}>{$t('modelHub.goExplore')}</Button>
              {/if}
            </div>
          </SettingsSection>
        {:else}
          <SettingsSection flush>
            <ul class="px-2 py-1">
              {#each downloadedModels as model (model.id)}
                {@const fit = fitForLocal(model)}
                {@const loaded = isLoaded(model)}
                <li class="model-line group">
                  <div class="min-w-0 flex-1">
                    <p class="flex items-center gap-2">
                      <span class="truncate text-sm font-medium text-foreground">{model.name}</span>
                      {#if loaded}<span class="row-state is-live"><span class="live-dot" aria-hidden="true"></span>{$t('modelHub.loaded')}</span>{/if}
                    </p>
                    <p class="model-meta">
                      <span class="truncate">{[model.architecture, model.quantization_name, formatBytes(Number(model.size_gb || 0) * 1024 ** 3)].filter(Boolean).join(' · ')}</span>
                      {@render fitNote(fit)}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    {#if loaded}
                      <Button variant="ghost" size="sm" onclick={() => appStore.stopLocalModel()}>{$t('modelHub.unload')}</Button>
                    {:else}
                      <Button variant="ghost" size="sm" onclick={() => appStore.openLocalModelLoadDialog(model)}>{$t('modelHub.load')}</Button>
                    {/if}
                    <Tooltip label={$t('modelHub.deleteTitle', { values: { name: model.name } })} position="bottom"><IconButton label={$t('modelHub.deleteTitle', { values: { name: model.name } })} variant="ghost" size="sm" class="text-muted-foreground hover:text-error"  onclick={() => removeModel(model)}><Trash2 /></IconButton></Tooltip>
                  </div>
                </li>
              {/each}
            </ul>
          </SettingsSection>
        {/if}
      </SettingsPage>

    {:else}
      <SettingsPage title={$t('modelHub.runningTitle')} description={$t('instances.description')}>
        <InstancesPanel {loadPhase} {loadProgress} onlibrary={() => (tab = 'library')} />
      </SettingsPage>
    {/if}
  </div>
{/key}

<style>
  /* One model per line: name and role, then one grey line of facts. Rows are
     separated by the hover band alone, not boxes. */
  .model-line {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.375rem 0.5rem;
    border-radius: var(--float-row-radius);
    transition: background-color var(--motion-instant) var(--motion-ease);
  }
  .model-line:hover { background: var(--surface-hover); }
  .model-line.is-selected { background: var(--surface-active); }
  .model-meta {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.125rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    white-space: nowrap;
  }
  .license-restricted { color: var(--warning); }
  .fit-note { color: var(--warning); }
  .fit-note::before { content: '·'; margin-right: 0.375rem; color: var(--muted-foreground); }
  .fit-note.is-error { color: var(--error); }
  .row-state {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .live-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: var(--radius-full);
    background: var(--success);
  }

  /* License chip: permissive licenses get the quiet green, restrictive ones amber. */
  .license-badge {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    height: 1.1rem;
    padding: 0 0.45rem;
    border-radius: var(--radius-full);
    background: var(--muted);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--muted-foreground);
    white-space: nowrap;
  }

  .license-badge.open {
    background: var(--accent-green-bg);
    color: var(--accent-green-text);
  }

  .license-badge.restricted {
    background: var(--accent-yellow-bg);
    color: var(--accent-yellow-text);
  }

  /* Three picks side by side in one card, split by hairlines. */
  .pick-grid { display: grid; }
  :global(.pick-cell.ui-local-2f53538a) {
    min-width: 0;
    padding: 0.75rem 1rem;
    text-align: left;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  :global(.pick-cell.ui-local-2f53538a) + :global(.pick-cell.ui-local-2f53538a) { border-top: 1px solid var(--border-subtle); }
  :global(.pick-cell:hover:not(:disabled).ui-local-2f53538a) { background: var(--float-row-hover); }
  :global(.pick-cell:disabled.ui-local-2f53538a) { cursor: default; opacity: 0.6; }
  @media (min-width: 640px) {
    .pick-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    :global(.pick-cell.ui-local-2f53538a) + :global(.pick-cell.ui-local-2f53538a) { border-top: 0; border-left: 1px solid var(--border-subtle); }
  }
</style>
