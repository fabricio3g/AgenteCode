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

  function formatBytes(bytes: number): string {
    if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
    return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
  }

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
    <Boxes class="h-4 w-4 text-[var(--text-secondary)]" />
    <span class="text-sm font-medium text-[var(--text)]">{$t('onboarding.downloadModel')}</span>
  </div>

  {#if checkingLocal}
    <div class="flex items-center justify-center py-8 text-[var(--text-muted)]">
      <LoaderCircle class="h-5 w-5 animate-spin" />
    </div>
  {:else}
    <div class="space-y-1.5">
      {#each models as model}
        {@const isLocal = isModelLocal(model)}
        {@const isSelected = selectedId === model.id}
        {@const isDownloading = downloading && selectedId === model.id}
        <button
          class="flex w-full items-center gap-3 rounded-lg border px-4 py-2.5 text-left transition
            {isSelected ? 'border-[var(--text)] bg-[var(--surface)]' : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--text)]'}"
          onclick={() => { selectedId = model.id; if (!isLocal) downloadModel(model); }}
          disabled={downloading && !isDownloading}
        >
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-[var(--text)] truncate">{model.label}</span>
              {#if model.recommended}
                <span class="rounded-full border border-[var(--text)] px-2 py-0.5 text-[10px] font-medium shrink-0">{$t('onboarding.recommended')}</span>
              {/if}
              {#if isLocal}
                <CheckCircle2 class="h-3.5 w-3.5 shrink-0 text-[var(--success)]" />
              {/if}
            </div>
            <div class="mt-0.5 flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <span>{model.sizeLabel}</span>
              {#if model.tags.length}
                <span>·</span>
                {#each model.tags.slice(0, 2) as tag}
                  <span class="rounded bg-[var(--surface-hover)] px-1.5 py-0.5">{tag}</span>
                {/each}
              {/if}
            </div>
          </div>
          {#if isDownloading}
            <LoaderCircle class="h-4 w-4 shrink-0 animate-spin" />
          {:else if !isLocal}
            <Download class="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          {/if}
        </button>
      {/each}
    </div>

    {#if downloading}
      <div class="space-y-1">
        <div class="h-1 overflow-hidden rounded-full bg-[var(--surface-hover)]">
          <div class="h-full bg-[var(--text)] transition-all" style="width: {downloadProgress}%"></div>
        </div>
        <p class="text-xs text-[var(--text-muted)]">{Math.round(downloadProgress)}%</p>
      </div>
    {/if}

    {#if downloadError}
      <p class="text-xs text-[var(--error)]">{downloadError}</p>
    {/if}
  {/if}

  <div class="mt-auto flex items-center justify-between pt-4">
    <button
      class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-4 py-2 text-sm font-medium transition hover:bg-[var(--surface-hover)]"
      onclick={onBack}
    >
      <ArrowLeft class="h-4 w-4" />
      {$t('onboarding.back')}
    </button>
    <button
      class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-hover)] bg-[var(--primary)] px-5 py-2 text-sm font-medium text-[var(--primary-fg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition hover:opacity-90 disabled:opacity-50"
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
