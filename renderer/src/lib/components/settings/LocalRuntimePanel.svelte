<svelte:options runes={true} />

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { RefreshCw, Trash2, Download, AlertTriangle, Cpu, Zap, ChevronDown, ChevronUp, Square, LoaderCircle } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { deleteRuntimeBinary, downloadRuntime, getInstalledRuntimes } from '$lib/services/files';
  import { getSupervisorStatus, getRuntimeTelemetry, stopLlama } from '$lib/services/runtime';
  import type { RuntimeTelemetry } from '$lib/types/bridge';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { listen } from '$lib/services/bridge';
  import { getRuntimeRecommendations, type RuntimeRecommendations } from '$lib/services/system-info';
  import { fetchLlamaReleaseAssets, toDownloadPayload, type ReleaseAsset } from '$lib/services/llama-releases';

  let { closeOnUse = false, embedded = false } = $props<{ closeOnUse?: boolean; embedded?: boolean }>();

  let platformInfo = $state<RuntimeRecommendations>({ platform: 'linux', arch: 'x64', gpu_backend: 'cpu', has_gpu: false, recommended_variant: 'cpu' });

  const platform = $derived({ os: platformInfo.platform, arch: platformInfo.arch });
  const hasGpu = $derived(platformInfo.has_gpu);
  const gpuBackend = $derived(platformInfo.gpu_backend.toLowerCase());

  let releaseAssets = $state<ReleaseAsset[]>([]);
  let releaseExtras = $state<ReleaseAsset[]>([]);
  let loadingRelease = $state(false);
  let releaseError = $state('');
  let releaseTag = $state('');

  async function fetchLatestRelease() {
    loadingRelease = true;
    releaseError = '';
    releaseAssets = [];
    releaseExtras = [];
    try {
      const result = await fetchLlamaReleaseAssets(platformInfo);
      releaseTag = result.tag;
      releaseAssets = result.assets;
      releaseExtras = result.extras;
      releaseError = result.error;
    } finally {
      loadingRelease = false;
    }
  }

  let runtimes = $state<any[]>([]);
  let supervisor = $state<any | null>(null);
  let telemetry = $state<RuntimeTelemetry | null>(null);

  async function refresh() {
    const out = await getInstalledRuntimes() as { runtimes?: any[] };
    runtimes = Array.isArray(out?.runtimes) ? out.runtimes : [];
    supervisor = await getSupervisorStatus().catch(() => null);
    telemetry = await getRuntimeTelemetry().catch(() => null);
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
    if (closeOnUse) appStore.runtimeManagerOpen = false;
  }

  let downloading = $state<string | null>(null);
  let downloadProgress = $state(0);
  let downloadPhase = $state('');
  let downloadError = $state('');
  let showAdvanced = $state(false);
  let customUrl = $state('');
  let customAsset = $state('');
  let customTag = $state('');

  let unlisten: (() => void) | null = null;
  let telemetryTimer: ReturnType<typeof setInterval> | null = null;

  async function installAsset(asset: ReleaseAsset) {
    downloading = asset.name;
    downloadProgress = 0;
    downloadPhase = 'downloading';
    downloadError = '';
    try {
      await downloadRuntime(toDownloadPayload(asset));
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

    telemetryTimer = setInterval(() => {
      void getRuntimeTelemetry().then((next) => { telemetry = next; }).catch(() => { telemetry = null; });
    }, 2000);
  });

  onDestroy(() => {
    unlisten?.();
    if (telemetryTimer) clearInterval(telemetryTimer);
  });
</script>

<div class={embedded ? 'rounded-2xl bg-[var(--muted)]' : 'flex-1 overflow-y-auto'}>
  {#if runtimes.length === 0}
    <div class="mx-5 mt-4 flex items-start gap-3 rounded-xl bg-[var(--surface)] px-4 py-3">
      <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
      <div>
        <p class="text-[13px] font-medium text-[var(--text)]">No runtime installed</p>
        <p class="mt-0.5 text-[12px] text-[var(--text-secondary)]">Download and install the llama.cpp runtime below to load local models.</p>
      </div>
    </div>
  {/if}

  <div class="space-y-3 p-5">
    <div class="flex items-center justify-between">
      <div>
        <p class="text-[13px] font-semibold text-[var(--text)]">Download runtime</p>
        <p class="text-[12px] text-[var(--text-muted)]">
          Detected: <span class="font-medium text-[var(--text-secondary)]">{platform.os === 'macos' ? 'macOS' : platform.os === 'windows' ? 'Windows' : 'Linux'} / {platform.arch}</span>
          {#if hasGpu}
            / <span class="font-medium text-[var(--text-secondary)]">{gpuBackend.toUpperCase()} GPU</span>
          {/if}
        </p>
      </div>
      <div class="flex items-center gap-1.5">
        {#if releaseTag}
          <span class="text-[12px] text-[var(--text-muted)]">{releaseTag}</span>
        {/if}
        <button class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] text-[var(--text-tertiary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={fetchLatestRelease} disabled={loadingRelease}>
          <RefreshCw class={`h-3 w-3 ${loadingRelease ? 'animate-spin' : ''}`} />
          {loadingRelease ? '' : 'Refresh'}
        </button>
      </div>
    </div>

    {#if releaseError}
      <div class="rounded-xl bg-[var(--surface)] px-3 py-2 text-[12px] text-[var(--text)]">{releaseError}</div>
    {/if}

    {#if loadingRelease}
      <div class="flex items-center gap-2 py-2 text-[13px] text-[var(--text-muted)]">
        <LoaderCircle class="h-4 w-4 animate-spin" />Fetching latest release from GitHub...
      </div>
    {:else if releaseAssets.length}
      <div class="space-y-2">
        {#each releaseAssets as asset}
          {@const isDownloading = downloading === asset.name}
          <div class="flex items-center justify-between gap-3 rounded-xl bg-[var(--surface)] px-4 py-3 transition">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                {#if asset.variant === 'recommended'}
                  <span class="inline-flex items-center gap-1 rounded-full bg-[var(--primary)] px-2 py-0.5 text-[10px] font-semibold text-[var(--primary-fg)]"><Zap class="h-2.5 w-2.5" />Recommended</span>
                {:else if asset.variant === 'gpu'}
                  <span class="inline-flex items-center gap-1 rounded-full bg-[var(--background)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]"><Zap class="h-2.5 w-2.5" />GPU</span>
                {:else}
                  <span class="inline-flex items-center gap-1 rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-tertiary)]"><Cpu class="h-2.5 w-2.5" />CPU</span>
                {/if}
                <span class="text-[12px] font-medium text-[var(--text-secondary)]">{asset.label}</span>
              </div>
              <p class="mt-0.5 text-[12px] text-[var(--text-muted)]">
                {asset.description}{#if asset.companions.length} — includes the CUDA runtime{/if}
              </p>
              {#if isDownloading}
                <div class="mt-1.5 space-y-1">
                  <div class="h-2 w-full overflow-hidden rounded-full bg-[var(--surface)]">
                    <div class="h-full rounded-full bg-[var(--primary)] transition-all" style="width:{downloadProgress}%"></div>
                  </div>
                  <p class="text-[10px] text-[var(--text-muted)]">{downloadPhase === 'extracting' ? 'Extracting...' : `Downloading... ${downloadProgress.toFixed(0)}%`}</p>
                </div>
              {/if}
            </div>
            <button
              class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-50 {asset.variant === 'recommended' ? 'bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'}"
              onclick={() => installAsset(asset)}
              disabled={!!downloading}
            >
              {#if isDownloading}
                <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
              {:else}
                <Download class="h-3.5 w-3.5" />
              {/if}
              {isDownloading ? (downloadPhase === 'extracting' ? 'Extracting...' : 'Downloading...') : 'Install'}
            </button>
          </div>
        {/each}
      </div>
    {:else if !loadingRelease && !releaseAssets.length}
      <p class="text-[13px] text-[var(--text-muted)]">No matching release assets found for your platform.</p>
    {/if}

    {#if downloadError}
      <div class="rounded-xl bg-[var(--surface)] px-3 py-2 text-[12px] text-[var(--text)]">{downloadError}</div>
    {/if}

    <button class="flex items-center gap-1 border-0 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]" onclick={() => (showAdvanced = !showAdvanced)}>
      {#if showAdvanced}<ChevronUp class="h-3.5 w-3.5" />{:else}<ChevronDown class="h-3.5 w-3.5" />{/if}
      Other builds / manual URL
    </button>
    {#if showAdvanced}
      {#if releaseExtras.length}
        <div class="space-y-2 rounded-xl bg-[var(--surface)] px-4 py-3">
          <p class="text-[12px] text-[var(--text-muted)]">Superseded builds for this platform.</p>
          {#each releaseExtras as extra}
            <div class="flex items-center justify-between gap-3">
              <span class="min-w-0 truncate text-[12px] text-[var(--text-secondary)]">{extra.label}</span>
              <button
                class="shrink-0 rounded-full px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                onclick={() => installAsset(extra)}
                disabled={!!downloading}
              >
                Install
              </button>
            </div>
          {/each}
        </div>
      {/if}
      <div class="space-y-2 rounded-xl bg-[var(--surface)] px-4 py-3">
        <input bind:value={customTag} placeholder="Release tag (e.g. b4620)" class="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--border-hover)]" />
        <input bind:value={customAsset} placeholder="Asset filename (e.g. llama-b4620-bin-ubuntu-x64.zip)" class="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--border-hover)]" />
        <input bind:value={customUrl} placeholder="Direct download URL" class="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--border-hover)]" />
        <button class="inline-flex items-center gap-1.5 rounded-full bg-[var(--primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" onclick={installCustom} disabled={!!downloading || !customUrl.trim()}>
          <Download class="h-3.5 w-3.5" />Install from URL
        </button>
      </div>
    {/if}
  </div>

  <div class="border-t border-[var(--border)] p-5">
    <div class="mb-3 flex items-center justify-between">
      <p class="text-[13px] font-semibold text-[var(--text)]">Installed runtimes</p>
      <button class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] text-[var(--text-tertiary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={refresh}>
        <RefreshCw class="h-3 w-3" />Refresh
      </button>
    </div>

    {#if !runtimes.length}
      <div class="rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-[13px] text-[var(--text-muted)]">
        No runtime binaries installed yet.
      </div>
    {:else}
      <div class="space-y-2">
        {#each runtimes as rt}
          {@const isActive = rt.is_active ?? (appStore.config?.llm?.local?.runtime_path === rt.path)}
          <div class="flex items-center justify-between gap-3 rounded-lg px-4 py-3 transition {isActive ? 'bg-[var(--surface-active)]' : 'bg-[var(--surface)]'}">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                {#if isActive}
                  <span class="inline-block h-1.5 w-1.5 rounded-full bg-[var(--primary)]"></span>
                {/if}
                <span class="truncate text-[13px] font-medium text-[var(--text-secondary)]">{rt.name}</span>
              </div>
              <p class="truncate text-[12px] text-[var(--text-muted)]">{rt.path}</p>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              {#if !isActive}
                <button class="inline-flex items-center gap-1.5 rounded-full bg-[var(--primary)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--primary-fg)] transition hover:opacity-90" onclick={() => useRuntime(rt.path)}>
                  Use
                </button>
              {:else}
                <span class="text-[12px] font-medium text-[var(--text-secondary)]">Active</span>
              {/if}
              <button class="rounded-full p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]" onclick={() => removeRuntime(rt.path)} title="Delete">
                <Trash2 class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if supervisor}
    <div class="border-t border-[var(--border)] p-5">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Runtime process</p>
          <p class="mt-0.5 text-[13px] font-medium text-[var(--text-secondary)]">
            {supervisor.load_phase || supervisor.state || 'unknown'}
            {#if supervisor.active_model} / <span class="text-[var(--text-muted)]">{supervisor.active_model.split(/[\\/]/).pop()}</span>{/if}
          </p>
          {#if supervisor.build_info}
            <p class="mt-0.5 text-[11px] text-[var(--text-muted)]">{supervisor.build_info}</p>
          {/if}
        </div>
        {#if supervisor.state !== 'idle' && supervisor.state !== 'unknown'}
          <button class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={stopRuntime}>
            <Square class="h-3 w-3" />Stop
          </button>
        {/if}
      </div>

      <!-- Measured from the server's own /props and /slots, not estimated. -->
      {#if supervisor.n_ctx || telemetry}
        <div class="mt-3 grid gap-2 grid-cols-2 sm:grid-cols-4">
          <div class="rounded-lg bg-[var(--surface)] px-3 py-2">
            <div class="text-[10px] uppercase tracking-[0.14em] text-[var(--text-tertiary)]">Context</div>
            <div class="mt-0.5 text-[12px] font-medium text-[var(--text)]">
              {(telemetry?.context_size ?? supervisor.n_ctx)?.toLocaleString() ?? '--'}
            </div>
          </div>
          <div class="rounded-lg bg-[var(--surface)] px-3 py-2">
            <div class="text-[10px] uppercase tracking-[0.14em] text-[var(--text-tertiary)]" title="High watermark of context observed since the server started">Peak ctx</div>
            <div class="mt-0.5 text-[12px] font-medium text-[var(--text)]">
              {telemetry?.context_percent != null ? `${telemetry.context_percent}%` : '--'}
            </div>
          </div>
          <div class="rounded-lg bg-[var(--surface)] px-3 py-2">
            <div class="text-[10px] uppercase tracking-[0.14em] text-[var(--text-tertiary)]">Slots</div>
            <div class="mt-0.5 text-[12px] font-medium text-[var(--text)]">
              {telemetry ? `${telemetry.slots_busy}/${telemetry.slots_total}` : (supervisor.total_slots ?? '--')}
            </div>
          </div>
          <div class="rounded-lg bg-[var(--surface)] px-3 py-2">
            <div class="text-[10px] uppercase tracking-[0.14em] text-[var(--text-tertiary)]">Tok/s</div>
            <div class="mt-0.5 text-[12px] font-medium text-[var(--text)]">
              {telemetry?.tokens_per_second != null ? telemetry.tokens_per_second.toFixed(1) : '--'}
            </div>
          </div>
        </div>
        {#if telemetry?.context_percent != null}
          <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-hover)]">
            <div class="h-full rounded-full bg-[var(--primary)] transition-all" style="width:{telemetry.context_percent}%"></div>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
