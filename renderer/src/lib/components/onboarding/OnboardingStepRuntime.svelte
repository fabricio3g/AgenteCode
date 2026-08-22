<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Cpu, ArrowRight, ArrowLeft, CheckCircle2, Download, LoaderCircle } from 'lucide-svelte';
  import { getRuntimeRecommendations, type RuntimeRecommendations } from '$lib/services/system-info';
  import { getInstalledRuntimes, downloadRuntime } from '$lib/services/files';
  import { listen } from '$lib/services/bridge';
  import { fetchLlamaReleaseAssets, toDownloadPayload, type ReleaseAsset } from '$lib/services/llama-releases';

  let { onNext, onBack } = $props<{
    onNext: (runtimePath: string) => void;
    onBack: () => void;
  }>();

  let platformInfo = $state<RuntimeRecommendations>({
    platform: 'linux', arch: 'x64', gpu_backend: 'cpu', has_gpu: false, recommended_variant: 'cpu'
  });
  let installedRuntimes = $state<any[]>([]);
  let loading = $state(true);
  let installing = $state(false);
  let installProgress = $state(0);
  let installError = $state('');
  let selectedAsset = $state<{ name: string; url: string } | null>(null);

  let releaseAssets = $state<ReleaseAsset[]>([]);

  async function fetchAssets() {
    const result = await fetchLlamaReleaseAssets(platformInfo);
    releaseAssets = result.assets;
  }

  async function installAsset(asset: ReleaseAsset) {
    installing = true;
    installError = '';
    installProgress = 0;
    selectedAsset = { name: asset.name, url: asset.url };
    try {
      const unlisten = await listen<{ progress: number }>('runtime-download-progress', (evt) => {
        installProgress = evt.progress ?? 0;
      });
      await downloadRuntime(toDownloadPayload(asset));
      unlisten();
      const result = await getInstalledRuntimes();
      installedRuntimes = result.runtimes || [];
    } catch (err) {
      installError = String((err as Error)?.message || err || 'Installation failed');
    } finally {
      installing = false;
    }
  }

  const hasInstalledRuntime = $derived(installedRuntimes.length > 0);
  const selectedRuntimePath = $derived(pickRuntimePath());

  function runtimeRank(runtime: any) {
    const variant = String(runtime?.variant || runtime?.name || runtime?.id || '').toLowerCase();
    if (runtime?.is_active) return 0;
    if (platformInfo.platform === 'macos' && variant.includes('metal')) return 1;
    if (platformInfo.gpu_backend === 'cuda' && variant.includes('cuda')) return 1;
    if (platformInfo.gpu_backend === 'vulkan' && variant.includes('vulkan')) return 1;
    if (variant.includes('cpu')) return 2;
    return 3;
  }

  function pickRuntimePath() {
    return [...installedRuntimes].sort((a, b) => runtimeRank(a) - runtimeRank(b))[0]?.path || '';
  }

  onMount(async () => {
    loading = true;
    try {
      const [info, runtimesResult] = await Promise.allSettled([
        getRuntimeRecommendations(),
        getInstalledRuntimes()
      ]);
      if (info.status === 'fulfilled') platformInfo = info.value;
      if (runtimesResult.status === 'fulfilled') installedRuntimes = runtimesResult.value.runtimes || [];
      await fetchAssets();
    } finally {
      loading = false;
    }
  });
</script>

<div class="flex flex-1 flex-col gap-5 px-6">
  <div class="flex items-center gap-2">
    <Cpu class="size-4 text-muted-foreground" />
    <span class="text-sm font-medium text-foreground">{$t('onboarding.runtime')}</span>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-8 text-muted-foreground">
      <LoaderCircle class="size-5 animate-spin" />
    </div>
  {:else if hasInstalledRuntime}
    <div class="aui-card-quiet space-y-3 p-4">
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 class="size-4 text-success" />
        <span>{$t('onboarding.runtimeInstalledReady')}</span>
      </div>
      <div class="space-y-1">
        {#each installedRuntimes.slice(0, 3) as runtime}
          <div class="flex items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2 text-xs">
            <span class="min-w-0 truncate text-foreground">{runtime.name || runtime.id || 'runtime'}</span>
            <span class="shrink-0 rounded-md bg-muted px-2 py-0.5 text-muted-foreground">{runtime.variant || 'auto'}</span>
          </div>
        {/each}
      </div>
    </div>
  {:else if releaseAssets.length > 0}
    <div class="space-y-1">
      {#each releaseAssets as asset}
        <button
          type="button"
          class="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted disabled:opacity-50"
          onclick={() => installAsset(asset)}
          disabled={installing}
        >
          <span class="flex-1 text-sm text-foreground">{asset.description}</span>
          {#if installing && selectedAsset?.name === asset.name}
            <LoaderCircle class="size-4 shrink-0 animate-spin" />
          {:else if asset.variant === 'recommended'}
            <span class="rounded-md bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">{$t('onboarding.recommended')}</span>
          {:else}
            <Download class="size-4 shrink-0 text-muted-foreground" />
          {/if}
        </button>
      {/each}
    </div>

    {#if installing}
      <div class="space-y-1.5">
        <div class="h-1 overflow-hidden rounded-full bg-muted">
          <div class="h-full bg-foreground transition-all" style="width: {installProgress}%"></div>
        </div>
        <p class="text-xs text-muted-foreground">{$t('onboarding.downloadingRuntime')} {Math.round(installProgress)}%</p>
      </div>
    {/if}

    {#if installError}
      <p class="text-xs text-error">{installError}</p>
    {/if}
  {:else}
    <p class="text-sm text-muted-foreground">{$t('onboarding.noRuntimeAvailable')}</p>
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
        onNext(selectedRuntimePath);
      }}
      disabled={!hasInstalledRuntime}
    >
      {$t('onboarding.next')}
      <ArrowRight class="size-4" />
    </button>
  </div>
</div>
