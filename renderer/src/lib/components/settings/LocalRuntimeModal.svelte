<svelte:options runes={true} />

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import { X, RefreshCw, Trash2, Download, CheckCircle2, AlertTriangle, Cpu, Zap, ChevronDown, ChevronUp, Square, LoaderCircle } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { deleteRuntimeBinary, downloadRuntime, getInstalledRuntimes } from '$lib/services/files';
  import { getSupervisorStatus, stopLlama } from '$lib/services/runtime';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { listen } from '$lib/services/tauri';
  import { getRuntimeRecommendations, type RuntimeRecommendations } from '$lib/services/system-info';

  // ---------- platform detection (from main process) ----------
  let platformInfo = $state<RuntimeRecommendations>({ platform: 'linux', arch: 'x64', gpu_backend: 'cpu', has_gpu: false, recommended_variant: 'cpu' });

  const platform = $derived({ os: platformInfo.platform, arch: platformInfo.arch });
  const hasGpu = $derived(platformInfo.has_gpu);
  const gpuBackend = $derived(platformInfo.gpu_backend.toLowerCase());

  // ---------- llama.cpp release assets ----------
  type ReleaseAsset = { name: string; url: string; tag: string; label: string; variant: 'recommended' | 'gpu' | 'cpu'; description: string };

  let releaseAssets = $state<ReleaseAsset[]>([]);
  let loadingRelease = $state(false);
  let releaseError = $state('');
  let releaseTag = $state('');

  // Hardcoded fallback assets for known stable llama.cpp release (b4887)
  // Used when GitHub API rate-limits (403)
  const FALLBACK_TAG = 'b4887';
  const FALLBACK_BASE = `https://github.com/ggerganov/llama.cpp/releases/download/${FALLBACK_TAG}`;
  function buildFallbackAssets(): ReleaseAsset[] {
    const { os, arch } = platform;
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
    const forPlatform = map.filter(a => a.os === os && (a.arch === arch || (os === 'macos')));
    // promote cpu → recommended if no GPU
    const assets: ReleaseAsset[] = forPlatform.map(a => {
      let variant = a.variant;
      if (variant === 'cpu' && !hasGpu) variant = 'recommended';
      if (variant === 'gpu' && gpuBackend === 'cuda' && a.description.includes('CUDA')) variant = 'recommended';
      if (variant === 'gpu' && gpuBackend === 'vulkan' && a.description.includes('Vulkan')) variant = 'recommended';
      return { name: a.name, url: `${FALLBACK_BASE}/${a.name}`, tag, label: a.name.replace(/^llama-[^-]+-bin-/, '').replace(/\.zip$/, ''), variant, description: a.description };
    });
    const order = { recommended: 0, gpu: 1, cpu: 2 };
    return assets.sort((a, b) => order[a.variant] - order[b.variant]);
  }

  async function fetchLatestRelease() {
    loadingRelease = true;
    releaseError = '';
    releaseAssets = [];
    try {
      const res = await fetch('https://api.github.com/repos/ggerganov/llama.cpp/releases/latest', {
        headers: {
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': '7context-desktop'
        }
      });
      if (res.status === 403 || res.status === 429) {
        // Rate-limited — use hardcoded fallback
        releaseTag = FALLBACK_TAG;
        releaseAssets = buildFallbackAssets();
        releaseError = `GitHub API rate-limited — showing known release ${FALLBACK_TAG}`;
        return;
      }
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const data = await res.json() as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
      releaseTag = data.tag_name;
      const { os, arch } = platform;
      const assets: ReleaseAsset[] = [];

      for (const a of (data.assets || [])) {
        const n = a.name.toLowerCase();
        if (!n.endsWith('.zip') && !n.includes('.tar')) continue;
        // platform match
        const matchLinux = os === 'linux' && (n.includes('ubuntu') || n.includes('linux'));
        const matchMac = os === 'macos' && n.includes('macos');
        const matchWin = os === 'windows' && n.includes('win');
        if (!matchLinux && !matchMac && !matchWin) continue;
        // arch match
        if (arch === 'arm64' && !n.includes('arm') && !n.includes('arm64') && os !== 'macos') continue;
        if (arch === 'x64' && n.includes('arm64')) continue;
        // skip unwanted variants
        if (n.includes('blas') || n.includes('sycl') || n.includes('rpc')) continue;
        // categorize
        const isCuda = n.includes('cuda');
        const isVulkan = n.includes('vulkan');
        const isMetal = n.includes('metal') || (os === 'macos');
        let variant: ReleaseAsset['variant'] = 'cpu';
        let description = 'CPU-only — works on all hardware';
        if (isCuda) { variant = gpuBackend === 'cuda' ? 'recommended' : 'gpu'; description = 'NVIDIA GPU acceleration (CUDA)'; }
        else if (isVulkan) { variant = gpuBackend === 'vulkan' ? 'recommended' : 'gpu'; description = 'GPU acceleration via Vulkan (AMD / Intel)'; }
        else if (isMetal && os === 'macos') { variant = 'recommended'; description = 'Apple Silicon / Metal GPU acceleration'; }
        else if (!hasGpu) variant = 'recommended';
        if (assets.some(x => x.variant === variant && x.label.includes('CUDA') && isCuda)) continue;
        assets.push({
          name: a.name,
          url: a.browser_download_url,
          tag: data.tag_name,
          label: a.name.replace(/^llama-[^-]+-bin-/, '').replace(/\.(zip|tar\.gz|tgz)$/, ''),
          variant,
          description
        });
      }
      const order = { recommended: 0, gpu: 1, cpu: 2 };
      releaseAssets = assets.sort((a, b) => order[a.variant] - order[b.variant]).slice(0, 8);
    } catch (e: any) {
      // Network failure — fall back to hardcoded assets
      releaseTag = FALLBACK_TAG;
      releaseAssets = buildFallbackAssets();
      releaseError = `Could not reach GitHub — showing known release ${FALLBACK_TAG}`;
    } finally {
      loadingRelease = false;
    }
  }

  // ---------- installed runtimes ----------
  let runtimes = $state<any[]>([]);
  let supervisor = $state<any | null>(null);

  async function refresh() {
    const out = await getInstalledRuntimes() as { runtimes?: any[] };
    runtimes = Array.isArray(out?.runtimes) ? out.runtimes : [];
    supervisor = await getSupervisorStatus().catch(() => null);
  }

  async function removeRuntime(path: string) {
    await deleteRuntimeBinary(path);
    await refresh();
  }

  async function stopRuntime() {
    await stopLlama();
    await refresh();
    await modelsStore.refreshStatus();
  }

  function useRuntime(path: string) {
    appStore.setLocalRuntimePath(path);
    appStore.runtimeManagerOpen = false;
  }

  // ---------- active download ----------
  let downloading = $state<string | null>(null); // asset name currently downloading
  let downloadProgress = $state(0);
  let downloadPhase = $state('');
  let downloadError = $state('');
  let showAdvanced = $state(false);
  let customUrl = $state('');
  let customAsset = $state('');
  let customTag = $state('');

  let unlisten: (() => void) | null = null;

  async function installAsset(asset: ReleaseAsset) {
    downloading = asset.name;
    downloadProgress = 0;
    downloadPhase = 'downloading';
    downloadError = '';
    try {
      await downloadRuntime({ download_url: asset.url, asset_name: asset.name, release_tag: asset.tag });
      await refresh();
    } catch (e: any) {
      downloadError = String(e?.message || e || 'Download failed');
    } finally {
      downloading = null;
    }
  }

  async function installCustom() {
    if (!customUrl.trim() || !customAsset.trim() || !customTag.trim()) return;
    downloading = customAsset.trim();
    downloadProgress = 0;
    downloadPhase = 'downloading';
    downloadError = '';
    try {
      await downloadRuntime({ download_url: customUrl.trim(), asset_name: customAsset.trim(), release_tag: customTag.trim() });
      await refresh();
    } catch (e: any) {
      downloadError = String(e?.message || e || 'Download failed');
    } finally {
      downloading = null;
    }
  }

  onMount(async () => {
    await refresh();
    await hardwareStore.refresh();
    try { platformInfo = await getRuntimeRecommendations(); } catch { /* use defaults */ }
    void fetchLatestRelease();
    unlisten = await listen('runtime-download-progress', (event: any) => {
      downloadProgress = Number(event?.progress ?? event?.payload?.progress ?? 0);
      downloadPhase = String(event?.phase ?? event?.payload?.phase ?? 'downloading');
    }) as (() => void);
  });

  onDestroy(() => { unlisten?.(); });
</script>

<div class="modal-backdrop fixed inset-0 z-[62] flex items-center justify-center bg-overlay px-4" role="dialog" aria-modal="true" transition:fade={{ duration: 150}}>
 <div class="modal-surface flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-[var(--surface)] shadow-2xl ring-1 ring-border" transition:flyAndScale={{ y: -12, start: 0.96, duration: 200}}>

 <!-- Header -->
 <div class="modal-header">
 <div>
 <h3 class="text-sm font-semibold text-[var(--text)]">Runtime Manager</h3>
 <p class="text-[12px] text-[var(--text-muted)]">llama.cpp — the engine that runs local models</p>
 </div>
 <button class="close-btn" onclick={() => (appStore.runtimeManagerOpen = false)}>
 <X class="h-4 w-4" />
 </button>
 </div>

 <div class="flex-1 overflow-y-auto">

 <!-- No-runtime warning banner -->
 {#if runtimes.length === 0}
 <div class="info-card mx-4 mt-4 px-4 py-3">
 <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
 <div>
 <p class="text-[13px] font-medium text-[var(--text)]">No runtime installed</p>
 <p class="mt-0.5 text-[12px] text-[var(--text-secondary)]">Download and install the llama.cpp runtime below to load local models.</p>
 </div>
 </div>
 {/if}

 <!-- Quick download: detected platform -->
 <div class="p-4 space-y-3">
 <div class="flex items-center justify-between">
 <div>
 <p class="text-[13px] font-semibold text-[var(--text)]">Download runtime</p>
 <p class="text-[11px] text-[var(--text-muted)]">
 Detected: <span class="font-medium text-[var(--text-secondary)]">{platform.os === 'macos' ? 'macOS' : platform.os === 'windows' ? 'Windows' : 'Linux'} · {platform.arch}</span>
 {#if hasGpu}
 · <span class="font-medium text-[var(--text-secondary)]">{gpuBackend.toUpperCase()} GPU</span>
 {/if}
 </p>
 </div>
 <div class="flex items-center gap-1.5">
 {#if releaseTag}
 <span class="text-[11px] text-[var(--text-muted)]">{releaseTag}</span>
 {/if}
 <button class="refresh-btn" onclick={fetchLatestRelease} disabled={loadingRelease}>
 <RefreshCw class={`h-3 w-3 ${loadingRelease ? 'animate-spin' : ''}`} />
 {loadingRelease ? '' : 'Refresh'}
 </button>
 </div>
 </div>

 {#if releaseError}
 {@const isFallback = releaseError.includes('rate-limited') || releaseError.includes('known release') || releaseError.includes('Could not reach')}
 <div class={`info-card px-3 py-2 text-[12px] ${isFallback ? '' : 'border-[var(--border-strong)]'}`}>{releaseError}</div>
 {/if}

 {#if loadingRelease}
 <div class="flex items-center gap-2 py-2 text-[13px] text-[var(--text-muted)]">
 <LoaderCircle class="h-4 w-4 animate-spin" />Fetching latest release from GitHub…
 </div>
 {:else if releaseAssets.length}
 <div class="space-y-2">
 {#each releaseAssets as asset}
 {@const isDownloading = downloading === asset.name}
 <div class="asset-card">
 <div class="min-w-0 flex-1">
 <div class="flex flex-wrap items-center gap-1.5">
 {#if asset.variant === 'recommended'}
 <span class="badge-recommended"><Zap class="h-2.5 w-2.5" />Recommended</span>
 {:else if asset.variant === 'gpu'}
 <span class="badge-gpu"><Zap class="h-2.5 w-2.5" />GPU</span>
 {:else}
 <span class="badge-cpu"><Cpu class="h-2.5 w-2.5" />CPU</span>
 {/if}
 <span class="text-[12px] font-medium text-[var(--text-secondary)]">{asset.label}</span>
 </div>
 <p class="mt-0.5 text-[11px] text-[var(--text-muted)]">{asset.description}</p>
 {#if isDownloading}
 <div class="mt-1.5 space-y-1">
 <div class="progress-bar">
 <div class="progress-fill" style="width:{downloadProgress}%"></div>
 </div>
 <p class="text-[10px] text-[var(--text-muted)]">{downloadPhase === 'extracting' ? 'Extracting…' : `Downloading… ${downloadProgress.toFixed(0)}%`}</p>
 </div>
 {/if}
 </div>
 <button
 class={`install-btn ${asset.variant === 'recommended' ? 'is-primary' : ''}`}
 onclick={() => installAsset(asset)}
 disabled={!!downloading}
 >
 {#if isDownloading}
 <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
 {:else}
 <Download class="h-3.5 w-3.5" />
 {/if}
 {isDownloading ? (downloadPhase === 'extracting' ? 'Extracting…' : 'Downloading…') : 'Install'}
 </button>
 </div>
 {/each}
 </div>
 {:else if !loadingRelease && !releaseAssets.length}
 <p class="text-[13px] text-[var(--text-muted)]">No matching release assets found for your platform.</p>
 {/if}

 {#if downloadError}
 <div class="info-card border-[var(--border-strong)] px-3 py-2 text-[12px]">{downloadError}</div>
 {/if}

 <!-- Advanced: manual URL -->
 <button class="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]" onclick={() => (showAdvanced = !showAdvanced)}>
 {#if showAdvanced}<ChevronUp class="h-3.5 w-3.5" />{:else}<ChevronDown class="h-3.5 w-3.5" />{/if}
 Custom / manual URL
 </button>
 {#if showAdvanced}
 <div class="advanced-card space-y-2 px-3 py-2">
 <input bind:value={customTag} placeholder="Release tag (e.g. b4620)" class="text-input" />
 <input bind:value={customAsset} placeholder="Asset filename (e.g. llama-b4620-bin-ubuntu-x64.zip)" class="text-input" />
 <input bind:value={customUrl} placeholder="Direct download URL" class="text-input" />
 <button class="secondary-btn" onclick={installCustom} disabled={!!downloading || !customUrl.trim()}>
 <Download class="h-3.5 w-3.5" />Install from URL
 </button>
 </div>
 {/if}
 </div>

 <!-- Installed runtimes -->
 <div class="section-divider p-4">
 <div class="mb-3 flex items-center justify-between">
 <p class="text-[13px] font-semibold text-[var(--text)]">Installed runtimes</p>
 <button class="refresh-btn" onclick={refresh}>
 <RefreshCw class="h-3 w-3" />Refresh
 </button>
 </div>

 {#if !runtimes.length}
 <div class="empty-state">
 No runtime binaries installed yet.
 </div>
 {:else}
  <div class="space-y-2">
  {#each runtimes as rt}
 {@const isActive = rt.is_active ?? (appStore.config?.llm?.local?.runtime_path === rt.path)}
 <div class={`runtime-card ${isActive ? 'is-active' : ''}`}>
 <div class="min-w-0 flex-1">
 <div class="flex items-center gap-1.5">
 {#if isActive}
 <span class="active-dot"></span>
 {/if}
 <span class="truncate text-[13px] font-medium text-[var(--text-secondary)]">{rt.name}</span>
 </div>
 <p class="truncate text-[11px] text-[var(--text-muted)]">{rt.path}</p>
 </div>
 <div class="flex shrink-0 items-center gap-1.5">
 {#if !isActive}
 <button class="secondary-btn" onclick={() => useRuntime(rt.path)}>
 Use
 </button>
 {:else}
 <span class="active-label">Active</span>
 {/if}
 <button class="delete-btn" onclick={() => removeRuntime(rt.path)} title="Delete">
 <Trash2 class="h-3.5 w-3.5" />
 </button>
 </div>
 </div>
 {/each}
 </div>
 {/if}
 </div>

 <!-- Supervisor status -->
 {#if supervisor}
 <div class="section-divider p-4">
 <div class="flex items-center justify-between">
 <div>
 <p class="section-label">Runtime process</p>
 <p class="mt-0.5 text-[13px] font-medium text-[var(--text-secondary)]">
 {supervisor.state || 'unknown'}
 {#if supervisor.active_model}· <span class="text-[var(--text-muted)]">{supervisor.active_model.split(/[\\/]/).pop()}</span>{/if}
 </p>
 </div>
 {#if supervisor.state !== 'idle' && supervisor.state !== 'unknown'}
 <button class="secondary-btn" onclick={stopRuntime}>
 <Square class="h-3 w-3" />Stop
 </button>
 {/if}
 </div>
 </div>
 {/if}

 </div>
 </div>
</div>

<style>
 .modal-backdrop {
 background: rgba(0, 0, 0, 0.5);
 }

 .modal-surface {
 background: var(--surface);
 border: 1px solid var(--border);
 border-radius: var(--radius-xl);
 box-shadow: var(--shadow-xl);
 }

 .modal-header {
 display: flex;
 align-items: center;
 justify-content: space-between;
 border-bottom: 1px solid var(--border);
 padding: 14px 20px;
 }

 .close-btn {
 display: flex;
 align-items: center;
 justify-content: center;
 width: 32px;
 height: 32px;
 border-radius: var(--radius-s);
 color: var(--text-muted);
 transition: color 0.12s, background 0.12s;
 border: 1px solid transparent;
 }

 .close-btn:hover {
 color: var(--text);
 background: var(--surface-highlight);
 border-color: var(--border-light);
 }

 .info-card {
 display: flex;
 align-items: flex-start;
 gap: 12px;
 border-radius: var(--radius-m);
 border: 1px solid var(--border);
 background: var(--surface-highlight);
 color: var(--text);
 }

 .refresh-btn {
 display: flex;
 align-items: center;
 gap: 6px;
 border-radius: var(--radius-s);
 border: 1px solid var(--border);
 padding: 4px 8px;
 font-size: 11px;
 color: var(--text-tertiary);
 transition: all 0.12s;
 }

 .refresh-btn:hover {
 color: var(--text-secondary);
 background: var(--surface-highlight);
 }

 .asset-card {
 display: flex;
 align-items: center;
 justify-content: space-between;
 gap: 12px;
 padding: 12px 14px;
 border-radius: var(--radius-m);
 border: 1px solid var(--border);
 background: var(--surface);
 transition: border-color 0.12s;
 }

 .asset-card:has(.badge-recommended) {
 border-color: var(--border-strong);
 background: var(--surface-highlight);
 }

 .badge-recommended,
 .badge-gpu,
 .badge-cpu {
 display: inline-flex;
 align-items: center;
 gap: 4px;
 border-radius: 9999px;
 padding: 2px 6px;
 font-size: 10px;
 font-weight: 600;
 }

 .badge-recommended {
 background: var(--primary);
 color: var(--primary-fg);
 }

 .badge-gpu {
 background: var(--surface-secondary);
 border: 1px solid var(--border);
 color: var(--text-secondary);
 }

 .badge-cpu {
 background: var(--surface-highlight);
 color: var(--text-tertiary);
 }

 .progress-bar {
 width: 100%;
 height: 6px;
 overflow: hidden;
 border-radius: 9999px;
 background: var(--surface-secondary);
 }

 .progress-fill {
 height: 100%;
 border-radius: 9999px;
 background: var(--primary);
 transition: width 0.2s;
 }

 .install-btn {
 display: inline-flex;
 align-items: center;
 gap: 6px;
 border-radius: var(--radius-s);
 padding: 6px 12px;
 font-size: 12px;
 font-weight: 500;
 transition: all 0.12s;
 border: 1px solid var(--border);
 color: var(--text-secondary);
 background: transparent;
 }

 .install-btn:hover {
 background: var(--surface-highlight);
 }

 .install-btn.is-primary {
 background: var(--primary);
 color: var(--primary-fg);
 border-color: transparent;
 }

 .install-btn.is-primary:hover {
 opacity: 0.9;
 }

 .install-btn:disabled {
 opacity: 0.5;
 cursor: not-allowed;
 }

 .advanced-card {
 border-radius: var(--radius-m);
 border: 1px solid var(--border);
 background: var(--surface-highlight);
 }

 .text-input {
 width: 100%;
 border-radius: var(--radius-s);
 border: 1px solid var(--border);
 background: transparent;
 padding: 6px 12px;
 font-size: 13px;
 color: var(--text);
 outline: none;
 transition: border-color 0.12s;
 }

 .text-input:focus {
 border-color: var(--border-strong);
 }

 .secondary-btn {
 display: inline-flex;
 align-items: center;
 gap: 6px;
 border-radius: var(--radius-s);
 border: 1px solid var(--border);
 padding: 4px 10px;
 font-size: 12px;
 font-weight: 500;
 color: var(--text-secondary);
 background: transparent;
 transition: all 0.12s;
 }

 .secondary-btn:hover {
 background: var(--surface-highlight);
 border-color: var(--border-strong);
 color: var(--text);
 }

 .section-divider {
 border-top: 1px solid var(--border-light);
 }

 .section-label {
 font-size: 11px;
 font-weight: 600;
 text-transform: uppercase;
 letter-spacing: 0.1em;
 color: var(--text-muted);
 }

 .empty-state {
 border-radius: var(--radius-m);
 border: 1px dashed var(--border);
 padding: 24px 16px;
 text-align: center;
 font-size: 13px;
 color: var(--text-muted);
 }

 .runtime-card {
 display: flex;
 align-items: center;
 justify-content: space-between;
 gap: 12px;
 padding: 10px 14px;
 border-radius: var(--radius-m);
 border: 1px solid var(--border);
 background: var(--surface);
 }

 .runtime-card.is-active {
 border-color: var(--border-strong);
 background: var(--surface-highlight);
 }

 .active-dot {
 width: 6px;
 height: 6px;
 border-radius: 50%;
 background: var(--primary);
 }

 .active-label {
 font-size: 11px;
 font-weight: 500;
 color: var(--text-secondary);
 }

 .delete-btn {
 border-radius: var(--radius-s);
 padding: 6px;
 color: var(--text-muted);
 transition: all 0.12s;
 }

 .delete-btn:hover {
 background: var(--surface-secondary);
 color: var(--text);
 }
</style>
