<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Cpu, ArrowRight, ArrowLeft, CheckCircle2, Download, LoaderCircle, AlertTriangle, Ban } from 'lucide-svelte';
  import { getRuntimeRecommendations, type RuntimeRecommendations } from '$lib/services/system-info';
  import { getInstalledRuntimes, downloadRuntime } from '$lib/services/files';
  import { listen } from '$lib/services/tauri';

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

  type ReleaseAsset = { name: string; url: string; tag: string; variant: 'recommended' | 'gpu' | 'cpu'; description: string };
  let releaseAssets = $state<ReleaseAsset[]>([]);

  const FALLBACK_TAG = 'b4887';
  const FALLBACK_BASE = `https://github.com/ggerganov/llama.cpp/releases/download/${FALLBACK_TAG}`;

  function buildFallbackAssets(): ReleaseAsset[] {
    const { platform: os, arch } = platformInfo;
    const hasGpu = platformInfo.has_gpu;
    const gpuBackend = platformInfo.gpu_backend.toLowerCase();
    const tag = FALLBACK_TAG;
    const map: { os: string; arch: string; name: string; variant: ReleaseAsset['variant']; description: string }[] = [
      { os: 'linux',   arch: 'x64',   name: `llama-${tag}-bin-ubuntu-x64.zip`,               variant: 'cpu',         description: 'CPU-only — works on all hardware' },
      { os: 'linux',   arch: 'x64',   name: `llama-${tag}-bin-ubuntu-x64-cuda-12.6.3.zip`,   variant: 'gpu',         description: 'NVIDIA GPU acceleration (CUDA 12.6)' },
      { os: 'linux',   arch: 'x64',   name: `llama-${tag}-bin-ubuntu-x64-vulkan.zip`,         variant: 'gpu',         description: 'GPU acceleration via Vulkan (AMD / Intel)' },
      { os: 'linux',   arch: 'arm64', name: `llama-${tag}-bin-ubuntu-arm64.zip`,              variant: 'cpu',         description: 'CPU-only — ARM64' },
      { os: 'macos',   arch: 'arm64', name: `llama-${tag}-bin-macos-arm64.zip`,               variant: 'recommended', description: 'Apple Silicon / Metal GPU acceleration' },
      { os: 'macos',   arch: 'x64',   name: `llama-${tag}-bin-macos-x64.zip`,                 variant: 'cpu',         description: 'macOS Intel — CPU' },
      { os: 'windows', arch: 'x64',   name: `llama-${tag}-bin-win-avx2-x64.zip`,              variant: 'cpu',         description: 'CPU — AVX2 (most modern CPUs)' },
      { os: 'windows', arch: 'x64',   name: `llama-${tag}-bin-win-cuda-12.6.3-x64.zip`,      variant: 'gpu',         description: 'NVIDIA GPU acceleration (CUDA 12.6)' },
      { os: 'windows', arch: 'x64',   name: `llama-${tag}-bin-win-vulkan-x64.zip`,            variant: 'gpu',         description: 'GPU acceleration via Vulkan (AMD / Intel)' },
    ];
    const forPlatform = map.filter(a => a.os === os && (a.arch === arch || os === 'macos'));
    const assets: ReleaseAsset[] = forPlatform.map(a => {
      let variant = a.variant;
      if (variant === 'cpu' && !hasGpu) variant = 'recommended';
      if (variant === 'gpu' && gpuBackend === 'cuda' && a.description.includes('CUDA')) variant = 'recommended';
      if (variant === 'gpu' && gpuBackend === 'vulkan' && a.description.includes('Vulkan')) variant = 'recommended';
      if (os === 'macos' && arch === 'arm64') variant = 'recommended';
      return { name: a.name, url: `${FALLBACK_BASE}/${a.name}`, tag, variant, description: a.description };
    });
    const order: Record<string, number> = { recommended: 0, gpu: 1, cpu: 2 };
    return assets.sort((a, b) => order[a.variant] - order[b.variant]);
  }

  async function fetchAssets() {
    try {
      const res = await fetch('https://api.github.com/repos/ggerganov/llama.cpp/releases/latest', {
        headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'chatealm-desktop' }
      });
      if (res.status === 403 || res.status === 429) {
        releaseAssets = buildFallbackAssets();
        return;
      }
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const data = await res.json() as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
      const os = platformInfo.platform;
      const arch = platformInfo.arch;
      const assets: ReleaseAsset[] = [];
      for (const a of (data.assets || [])) {
        const n = a.name.toLowerCase();
        if (!n.endsWith('.zip') && !n.includes('.tar')) continue;
        const matchLinux = os === 'linux' && (n.includes('ubuntu') || n.includes('linux'));
        const matchMac = os === 'macos' && n.includes('macos');
        const matchWin = os === 'windows' && n.includes('win');
        if (!matchLinux && !matchMac && !matchWin) continue;
        if (arch === 'arm64' && !n.includes('arm') && !n.includes('arm64') && os !== 'macos') continue;
        if (arch === 'x64' && n.includes('arm64')) continue;
        if (n.includes('blas') || n.includes('sycl') || n.includes('rpc')) continue;

        let variant: ReleaseAsset['variant'] = 'cpu';
        if (n.includes('cuda') || n.includes('vulkan') || n.includes('hipblas') || n.includes('rocm')) variant = 'gpu';
        if (os === 'macos') variant = 'recommended';

        const isRecommended = (variant === 'gpu' && platformInfo.gpu_backend === 'cuda' && n.includes('cuda')) ||
          (variant === 'gpu' && platformInfo.gpu_backend === 'vulkan' && n.includes('vulkan')) ||
          (os === 'macos' && arch === 'arm64');
        if (isRecommended) variant = 'recommended';
        if (variant === 'cpu' && !platformInfo.has_gpu) variant = 'recommended';

        let description = 'CPU-only runtime';
        if (n.includes('cuda')) description = 'NVIDIA GPU (CUDA)';
        else if (n.includes('vulkan')) description = 'GPU (Vulkan — AMD/Intel)';
        else if (os === 'macos') description = 'Apple Metal acceleration';
        else if (n.includes('avx')) description = 'CPU (AVX2)';

        assets.push({ name: a.name, url: a.browser_download_url, tag: data.tag_name, variant, description });
      }
      const order: Record<string, number> = { recommended: 0, gpu: 1, cpu: 2 };
      releaseAssets = assets.sort((a, b) => order[a.variant] - order[b.variant]);
    } catch {
      releaseAssets = buildFallbackAssets();
    }
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
      await downloadRuntime({
        download_url: asset.url,
        asset_name: asset.name,
        release_tag: asset.tag,
      });
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
    <Cpu class="h-4 w-4 text-[var(--text-secondary)]" />
    <span class="text-sm font-medium text-[var(--text)]">{$t('onboarding.runtime')}</span>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-8 text-[var(--text-muted)]">
      <LoaderCircle class="h-5 w-5 animate-spin" />
    </div>
  {:else if hasInstalledRuntime}
    <div class="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <CheckCircle2 class="h-4 w-4 text-[var(--success)]" />
      <span>{$t('onboarding.runtimeInstalledReady')}</span>
    </div>
  {:else if releaseAssets.length > 0}
    <div class="space-y-1.5">
      {#each releaseAssets as asset}
        <button
          class="flex w-full items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-left transition hover:border-[var(--text)]"
          onclick={() => installAsset(asset)}
          disabled={installing}
        >
          <span class="flex-1 text-sm text-[var(--text)]">{asset.description}</span>
          {#if installing && selectedAsset?.name === asset.name}
            <LoaderCircle class="h-4 w-4 shrink-0 animate-spin" />
          {:else if asset.variant === 'recommended'}
            <span class="rounded-full border border-[var(--text)] px-2 py-0.5 text-[10px] font-medium">{$t('onboarding.recommended')}</span>
          {:else}
            <Download class="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          {/if}
        </button>
      {/each}
    </div>

    {#if installing}
      <div class="space-y-1.5">
        <div class="h-1 overflow-hidden rounded-full bg-[var(--surface-highlight)]">
          <div class="h-full bg-[var(--text)] transition-all" style="width: {installProgress}%"></div>
        </div>
        <p class="text-xs text-[var(--text-muted)]">{$t('onboarding.downloadingRuntime')} {Math.round(installProgress)}%</p>
      </div>
    {/if}

    {#if installError}
      <p class="text-xs text-[var(--error)]">{installError}</p>
    {/if}
  {:else}
    <p class="text-sm text-[var(--text-muted)]">{$t('onboarding.noRuntimeAvailable')}</p>
  {/if}

  <div class="mt-auto flex items-center justify-between pt-4">
    <button
      class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-4 py-2 text-sm transition hover:bg-[var(--surface-highlight)]"
      onclick={onBack}
    >
      <ArrowLeft class="h-4 w-4" />
    </button>
    <button
      class="inline-flex items-center gap-1.5 rounded-full bg-[var(--text)] px-5 py-2 text-sm font-medium text-[var(--surface)] transition hover:opacity-90 disabled:opacity-50"
      onclick={() => {
        const path = installedRuntimes[0]?.path || '';
        onNext(path);
      }}
      disabled={!hasInstalledRuntime}
    >
      {$t('onboarding.next')}
    </button>
  </div>
</div>
