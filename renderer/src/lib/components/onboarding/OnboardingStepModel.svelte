<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Boxes, ArrowRight, ArrowLeft, Download, LoaderCircle, CheckCircle2, AlertTriangle, Ban } from 'lucide-svelte';
  import { getModelCatalog, getRecommendedModels, type OnboardingModel } from '$lib/services/onboarding';
  import { startDownloadHf, getDownloadJobs, cancelDownloadJob } from '$lib/services/downloads';
  import { getLocalModels } from '$lib/services/models';
  import { invoke } from '$lib/services/tauri';
  import { listen } from '$lib/services/tauri';
  import type { HardwareInfo } from '$lib/types/tauri';

  let { onNext, onBack, hardware } = $props<{
    onNext: (modelPath: string) => void;
    onBack: () => void;
    hardware: HardwareInfo | null;
  }>();

  let models = $state<OnboardingModel[]>([]);
  let selectedId = $state<string | null>(null);
  let downloading = $state(false);
  let downloadJobId = $state<string | null>(null);
  let downloadProgress = $state(0);
  let downloadError = $state('');
  let localModelPaths = $state<Set<string>>(new Set());
  let checkingLocal = $state(true);

  const recommendedModel = $derived(models.find(m => m.recommended) || models[0]);

  $effect(() => {
    if (!selectedId && models.length > 0) {
      selectedId = models[0].id;
    }
  });

  function isModelLocal(model: OnboardingModel): boolean {
    return localModelPaths.has(model.filename);
  }

  async function refreshLocalModels() {
    try {
      const resp = await getLocalModels();
      localModelPaths = new Set(resp.map(m => m.path.split('/').pop() || m.name));
    } catch {
      // ignore
    } finally {
      checkingLocal = false;
    }
  }

  async function downloadModel(model: OnboardingModel) {
    downloading = true;
    downloadError = '';
    downloadProgress = 0;
    downloadJobId = null;
    selectedId = model.id;

    // Check if already downloaded
    if (isModelLocal(model)) {
      downloading = false;
      return;
    }

    try {
      // startDownloadHf fires the download in the background and returns
      // immediately.  We listen for progress/completion events to know when
      // the file is actually ready.
      const downloadDone = new Promise<{ status: string; error?: string }>((resolve, reject) => {
        const unlisten = listen<{ status: string; progress: number; error?: string; dest_path?: string; job_id?: string }>('download-progress', (evt) => {
          if (evt.job_id && !downloadJobId) downloadJobId = evt.job_id;
          downloadProgress = Math.max(downloadProgress, evt.progress ?? 0);
          if (evt.status === 'completed') {
            void unlisten.then((fn) => fn());
            resolve(evt);
          } else if (evt.status === 'error') {
            void unlisten.then((fn) => fn());
            resolve(evt);
          } else if (evt.status === 'cancelled') {
            void unlisten.then((fn) => fn());
            reject(new Error($t('onboarding.downloadCancelled')));
          }
        });
      });

      const jobId = await startDownloadHf({
        repo_id: model.repoId,
        file: model.filename,
      });
      downloadJobId = jobId;

      const result = await downloadDone;
      if (result.status === 'error') {
        throw new Error(result.error || 'Download failed');
      }
      await refreshLocalModels();
    } catch (err) {
      downloadError = String((err as Error)?.message || err || $t('onboarding.downloadFailed'));
    } finally {
      downloading = false;
      downloadJobId = null;
    }
  }

  async function cancelDownload() {
    if (downloadJobId) {
      try {
        await cancelDownloadJob(downloadJobId);
      } catch { /* ignore */ }
      downloadJobId = null;
    }
    downloading = false;
    downloadError = '';
  }

  const selectedModel = $derived(models.find(m => m.id === selectedId));
  const hasLocalModel = $derived(models.some(m => isModelLocal(m)));

  onMount(async () => {
    models = getRecommendedModels(hardware);
    await refreshLocalModels();
  });
</script>

<div class="flex flex-1 flex-col gap-5 px-6">
  <div class="flex items-center gap-2">
    <Boxes class="size-4 text-muted-foreground" />
    <span class="text-sm font-medium text-foreground">{$t('onboarding.downloadModel')}</span>
  </div>

  {#if checkingLocal}
    <div class="flex items-center justify-center py-8 text-muted-foreground">
      <LoaderCircle class="size-5 animate-spin" />
    </div>
  {:else}
    <div class="space-y-1.5">
      {#each models as model}
        {@const isLocal = isModelLocal(model)}
        {@const isSelected = selectedId === model.id}
        {@const isDownloading = downloading && selectedId === model.id}
        <button
          type="button"
          class="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors
            {isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}"
          onclick={() => { selectedId = model.id; if (!isLocal) downloadModel(model); }}
          disabled={downloading && !isDownloading}
        >
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium">{model.label}</span>
              {#if model.recommended}
                <span class="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium {isSelected ? 'bg-primary-foreground/15' : 'bg-muted text-muted-foreground'}">{$t('onboarding.recommended')}</span>
              {/if}
              {#if isLocal}
                <CheckCircle2 class="size-3.5 shrink-0 {isSelected ? 'opacity-90' : 'text-success'}" />
              {/if}
            </div>
            <div class="mt-0.5 flex items-center gap-2 text-xs {isSelected ? 'opacity-80' : 'text-muted-foreground'}">
              <span>{model.sizeLabel}</span>
              {#if model.tags.length}
                <span>·</span>
                {#each model.tags.slice(0, 2) as tag}
                  <span class="rounded px-1.5 py-0.5 {isSelected ? 'bg-primary-foreground/10' : 'bg-muted'}">{tag}</span>
                {/each}
              {/if}
            </div>
          </div>
          {#if isDownloading}
            <LoaderCircle class="size-4 shrink-0 animate-spin" />
          {:else if !isLocal}
            <Download class="size-4 shrink-0 opacity-70" />
          {/if}
        </button>
      {/each}
    </div>

    {#if downloading}
      <div class="space-y-1">
        <div class="h-1 overflow-hidden rounded-full bg-muted">
          <div class="h-full bg-foreground transition-all" style="width: {downloadProgress}%"></div>
        </div>
        <p class="text-xs text-muted-foreground">{Math.round(downloadProgress)}%</p>
      </div>
    {/if}

    {#if downloadError}
      <p class="text-xs text-error">{downloadError}</p>
    {/if}
  {/if}

  <div class="mt-auto flex items-center justify-between pt-4">
    <button type="button" class="aui-btn aui-btn-ghost gap-1.5 px-4" onclick={onBack}>
      <ArrowLeft class="size-4" />
      {$t('onboarding.back')}
    </button>
    <button
      type="button"
      class="aui-btn aui-btn-primary gap-1.5 px-5"
      onclick={() => {
        const local = models.find(m => isModelLocal(m));
        if (local) onNext(local.filename);
      }}
      disabled={!hasLocalModel}
    >
      {$t('onboarding.next')}
      <ArrowRight class="h-4 w-4" />
    </button>
  </div>
</div>
