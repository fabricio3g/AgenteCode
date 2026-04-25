<svelte:options runes={true} />

<script lang="ts">
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import type { GgufMeta, HardwareInfo, RecommendedSettings } from '$lib/types/tauri';
  import { AlertTriangle, BrainCircuit, ChevronDown, ChevronRight, Cpu, Eye, Gauge, HardDrive, Layers3, LoaderCircle, MemoryStick, PowerOff, RotateCcw, SlidersHorizontal, Sparkles, Wrench, X } from 'lucide-svelte';
  import { untrack } from 'svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { getHardwareLimits } from '$lib/services/hardware';
  import { getGgufMetadata } from '$lib/services/models';
  import { getRecommendedSettings } from '$lib/services/runtime';
  import { getInstalledRuntimes } from '$lib/services/files';

  const contextPresets = [4096, 8192, 16384, 32768];
  const cacheTypes = ['f16', 'q8_0', 'q4_0'];

  let metadata = $state<GgufMeta | null>(null);
  let hardware = $state<HardwareInfo | null>(null);
  let recommended = $state<RecommendedSettings | null>(null);
  let advancedOpen = $state(false);
  let loadingMeta = $state(false);
  let viewMode = $state<'simple' | 'advanced'>('simple');

  const target = $derived(appStore.localModelLoadTarget);
  const isAnyModelLoaded = $derived(Boolean(modelsStore.status?.active_model));
  const loadedModelLabel = $derived(
    String(modelsStore.status?.active_model || '').split(/[\\/]/).pop() || ''
  );
  const maxContext = $derived(Math.max(512, Number(metadata?.context_length || target?.context_length || 4096)));
  const blockCount = $derived(Math.max(0, Number(metadata?.block_count || 0)));
  const parameterCount = $derived(Number(metadata?.parameter_count || 0));
  const fileSizeBytes = $derived(Number(metadata?.file_size_bytes || 0));
  const gpuLayersMax = $derived.by(() => {
    const current = Number(appStore.localModelLoadGpuLayers || 0);
    if (blockCount > 0) return Math.max(blockCount, current);
    return Math.max(80, current);
  });
  const cpuThreadsMax = $derived(Math.max(1, Number(hardware?.cpu_threads || navigator.hardwareConcurrency || 4)));

  // Local slider state — decoupled from store to avoid re-renders on every tick
  let localContextLength = $state(Number(appStore.localModelLoadContextLength || 4096));
  let localGpuLayers = $state(Number(appStore.localModelLoadGpuLayers || 0));
  let localCpuThreads = $state(Number(appStore.localModelLoadCpuThreads || 4));

  // Clamped computed values from local state
  const contextLength = $derived(Math.max(512, Math.min(maxContext, localContextLength)));
  const gpuLayers = $derived(Math.max(0, Math.min(gpuLayersMax, localGpuLayers)));
  const cpuThreads = $derived(Math.max(1, Math.min(cpuThreadsMax, localCpuThreads)));
  const batchSize = $derived(Math.max(1, Number(appStore.localModelLoadBatchSize || 512)));

  function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / (1024 ** index)).toFixed(index >= 3 ? 2 : 0)} ${units[index]}`;
  }

  function formatParams(value: number) {
    if (!Number.isFinite(value) || value <= 0) return '';
    return `${(value / 1e9).toFixed(1)}B params`;
  }

  function cacheQuantFactor(type: string) {
    if (type === 'q4_0') return 0.25;
    if (type === 'q8_0') return 0.5;
    return 1;
  }

  const memoryEstimate = $derived.by(() => {
    const headCount = Number(metadata?.head_count || 32);
    const headCountKv = Number(metadata?.head_count_kv || headCount);
    const embeddingLength = Number(metadata?.embedding_length || 4096);
    const headDim = headCount > 0 ? embeddingLength / headCount : 128;
    const effectiveLayers = Math.max(1, blockCount || 32);
    const fileSizeGb = fileSizeBytes / (1024 ** 3);
    const kvCacheBytes = 2 * headCountKv * headDim * contextLength * 2 * effectiveLayers;
    const kvCacheGb = (kvCacheBytes / (1024 ** 3))
      * ((cacheQuantFactor(appStore.localModelLoadCacheTypeK) + cacheQuantFactor(appStore.localModelLoadCacheTypeV)) / 2);
    const totalGb = (fileSizeGb * 1.05) + kvCacheGb + 0.3;
    const layerFraction = effectiveLayers > 0 ? Math.min(gpuLayers / effectiveLayers, 1) : 0;
    const gpuGb = gpuLayers > 0
      ? (fileSizeGb * layerFraction) + (appStore.localModelLoadOffloadKvCache ? kvCacheGb : 0)
      : 0;
    const ramNeededGb = Math.max(0, totalGb - gpuGb);

    const warnings: string[] = [];
    let compatible = true;
    if (hardware) {
      if (ramNeededGb > Number(hardware.free_ram_gb || 0) * 0.9) {
        warnings.push(`Estimated RAM usage (${ramNeededGb.toFixed(1)} GB) is close to available RAM (${Number(hardware.free_ram_gb || 0).toFixed(1)} GB).`);
      }
      if (ramNeededGb > Number(hardware.total_ram_gb || 0) * 0.95) {
        compatible = false;
        warnings.push('Estimated RAM usage exceeds total system RAM.');
      }
      if (gpuLayers > 0 && Number(hardware.vram_gb || 0) > 0 && gpuGb > Number(hardware.vram_gb || 0) * 0.95) {
        warnings.push(`GPU layers may exceed VRAM (${gpuGb.toFixed(1)} GB > ${Number(hardware.vram_gb || 0).toFixed(1)} GB).`);
      }
    }

    return {
      totalGb,
      gpuGb,
      ramNeededGb,
      compatible,
      warnings
    };
  });

  const toolSupport = $derived.by(() => {
    if (metadata?.chat_template_uses_tools === true) return { label: 'Supported', tone: 'text-fg' };
    if (metadata?.chat_template_uses_tools === false) return { label: 'Not supported', tone: 'text-fg-secondary' };
    if (!loadingMeta) return { label: 'Not supported', tone: 'text-fg-secondary' };
    return { label: 'Unknown', tone: 'text-fg-secondary' };
  });

  function applyRecommendedPreset() {
    if (!recommended) return;
    localContextLength = Number(recommended.context_length || contextLength);
    localGpuLayers = Number(recommended.gpu_layers || 0);
    localCpuThreads = Number(recommended.cpu_threads || cpuThreads);
    appStore.localModelLoadContextLength = String(localContextLength);
    appStore.localModelLoadGpuLayers = String(localGpuLayers);
    appStore.localModelLoadCpuThreads = String(localCpuThreads);
    appStore.localModelLoadBatchSize = String(recommended.batch_size || batchSize);
    appStore.localModelLoadFlashAttention = recommended.flash_attention ?? true;
    appStore.localModelLoadOffloadKvCache = recommended.offload_kv ?? true;
    appStore.localModelLoadMmap = recommended.use_mmap ?? true;
  }

  function resetToSavedDefaults() {
    if (!target) return;
    void appStore.openLocalModelLoadDialog(target);
  }

  // Sync local slider values when target model changes (i.e., a new dialog opens)
  $effect(() => {
    void target; // track target changes
    const storedCtx = appStore.localModelLoadContextLength;
    const storedGpu = appStore.localModelLoadGpuLayers;
    const storedCpu = appStore.localModelLoadCpuThreads;
    localContextLength = Number(storedCtx || 4096);
    // Default to all GPU layers (blockCount) in simple mode if no preference stored
    localGpuLayers = storedGpu ? Number(storedGpu) : gpuLayersMax;
    localCpuThreads = Number(storedCpu || 4);
  });

  // Commit local values to store (called on slider change / input blur)
  function commitContext() { appStore.localModelLoadContextLength = String(localContextLength); }
  function commitGpuLayers() { appStore.localModelLoadGpuLayers = String(localGpuLayers); }
  function commitCpuThreads() { appStore.localModelLoadCpuThreads = String(localCpuThreads); }

  $effect(() => {
    const model = target;
    if (!model?.path) return;
    loadingMeta = true;
    metadata = null;
    hardware = null;
    recommended = null;
    // Don't track localContextLength/localGpuLayers — fetch once per model, not on every slider tick
    const ctx = untrack(() => Number(appStore.localModelLoadContextLength || 0)) || undefined;
    const gpu = untrack(() => Number(appStore.localModelLoadGpuLayers || 0)) || undefined;
    void Promise.allSettled([
      getGgufMetadata(model.path),
      getHardwareLimits(),
      getRecommendedSettings(model.path, ctx, gpu, appStore.localModelLoadRuntimePath || appStore.config?.llm?.local?.runtime_path)
    ]).then((results) => {
      const [metaResult, hardwareResult, recommendedResult] = results;
      if (metaResult.status === 'fulfilled') metadata = metaResult.value;
      if (hardwareResult.status === 'fulfilled') hardware = hardwareResult.value;
      if (recommendedResult.status === 'fulfilled') recommended = recommendedResult.value;
      loadingMeta = false;
    });
  });

  let hasRuntime = $state<boolean | null>(null);
  $effect(() => {
    if (target) {
      void getInstalledRuntimes().then(r => { hasRuntime = (r.runtimes?.length ?? 0) > 0; }).catch(() => { hasRuntime = null; });
    }
  });
</script>

{#if target}
  <div   class="modal-backdrop fixed inset-0 z-[64] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true" transition:fade={{ duration: 150}}>
  <div class="modal-surface max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-[var(--surface)] p-5 shadow-2xl ring-1 ring-border" transition:flyAndScale={{ y: -12, start: 0.96, duration: 200}}>
 <div class="mb-3 flex items-start justify-between gap-3">
 <div class="min-w-0">
 <div class="text-sm font-semibold text-[var(--text)]">Load local model</div>
 <div class="truncate text-xs text-[var(--text-tertiary)]">{target.name}</div>
 <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
 {#if metadata?.architecture}
 <span class="rounded-full border border-[var(--border)] px-2.5 py-1 text-[var(--text-secondary)]">{metadata.architecture}</span>
 {/if}
 {#if metadata?.quantization_name}
 <span class="rounded-full border border-[var(--border)] px-2.5 py-1 text-[var(--text-secondary)]">{metadata.quantization_name}</span>
 {/if}
 {#if parameterCount > 0}
 <span class="rounded-full border border-[var(--border)] px-2.5 py-1 text-[var(--text-secondary)]">{formatParams(parameterCount)}</span>
 {/if}
 {#if fileSizeBytes > 0}
 <span class="rounded-full border border-[var(--border)] px-2.5 py-1 text-[var(--text-secondary)]">{formatBytes(fileSizeBytes)}</span>
 {/if}
 <span class={`rounded-full border border-[var(--border)] px-2.5 py-1 ${toolSupport.tone} `}>
 <span class="inline-flex items-center gap-1">
 <Wrench class="h-3 w-3" />
 Tool calling: {toolSupport.label}
 </span>
 </span>
 {#if appStore.localModelLoadMmprojPath}
 <span class="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-highlight)] px-2.5 py-1 text-[var(--text-secondary)]">
 <Eye class="h-3 w-3" />
 <span class="font-medium">Vision enabled</span>
 <span class="text-[var(--text-muted)]">·</span>
 <span class="truncate max-w-[160px] text-[var(--text-muted)]">{appStore.localModelLoadMmprojPath.split(/[/\\]/).pop()}</span>
 </span>
 {/if}
 </div>
 </div>
 <button class="rounded-full p-2 text-[var(--text-muted)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]" onclick={() => appStore.closeLocalModelLoadDialog()} aria-label="Close load dialog">
 <X class="h-4 w-4" />
 </button>
 </div>

 <!-- Runtime missing warning -->
 {#if hasRuntime === false}
  <div class="mb-4 flex items-start gap-3 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-highlight)] px-4 py-3">
  <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
  <div class="flex-1 min-w-0">
  <p class="text-[13px] font-medium text-[var(--text)]">Runtime not installed</p>
  <p class="mt-0.5 text-[12px] text-[var(--text-secondary)]">The llama.cpp runtime is required to run local models. Install it first.</p>
  </div>
   <button
   class="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-[var(--text)] px-3 py-1.5 text-[12px] font-semibold text-[var(--surface)] transition hover:opacity-80"
   onclick={() => { appStore.closeLocalModelLoadDialog(); appStore.runtimeManagerOpen = true;}}
   >
  Install Runtime
  </button>
  </div>
 {/if}

   <!-- View mode toggle -->
   <div class="mb-3 flex items-center gap-2">
   <div class="chateaui-segmented">
   <button class={`chateaui-segment px-3 py-1.5 text-xs font-medium transition ${viewMode === 'simple' ? 'is-active' : ''}`} onclick={() => (viewMode = 'simple')}>Simple</button>
   <button class={`chateaui-segment flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition ${viewMode === 'advanced' ? 'is-active' : ''}`} onclick={() => (viewMode = 'advanced')}>
   <SlidersHorizontal class="h-3 w-3" />
   Advanced
   </button>
   </div>
  {#if loadingMeta}
  <span class="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
  <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
  Loading metadata…
  </span>
  {/if}
  </div>

  {#if viewMode === 'simple'}
  <!-- ==================== SIMPLE VIEW ==================== -->
  <div class="simple-view space-y-4">

    <!-- GPU layers -->
    <div class="flex items-center gap-4">
      <span class="text-xs text-[var(--text-secondary)] w-20">GPU</span>
      <div class="flex items-center gap-1.5 p-0.5 bg-[var(--surface-highlight)] rounded-full border border-[var(--border-light)]">
        <button
          class={`px-3 py-1 text-xs rounded-full transition ${gpuLayers === gpuLayersMax ? 'bg-[var(--text)] text-[var(--surface)]' : 'hover:bg-[var(--surface-highlight)] text-[var(--text-tertiary)] hover:text-[var(--text)]'}`}
          onclick={() => { localGpuLayers = gpuLayersMax; commitGpuLayers(); }}
        >
          All ({gpuLayersMax})
        </button>
        <button
          class={`px-3 py-1 text-xs rounded-full transition ${gpuLayers === 0 ? 'bg-[var(--text)] text-[var(--surface)]' : 'hover:bg-[var(--surface-highlight)] text-[var(--text-tertiary)] hover:text-[var(--text)]'}`}
          onclick={() => { localGpuLayers = 0; commitGpuLayers(); }}
        >
          CPU
        </button>
      </div>
      <input
        type="range"
        min="0"
        max={gpuLayersMax}
        value={localGpuLayers}
        oninput={(e) => { localGpuLayers = Number((e.target as HTMLInputElement).value);}}
        onchange={commitGpuLayers}
        class="flex-1 h-1 bg-[var(--border)] rounded-full appearance-none cursor-pointer accent-black dark:accent-white"
      />
      <span class="text-xs text-[var(--text-secondary)] w-10 text-right">{gpuLayers}</span>
    </div>

    <!-- Context length -->
    <div class="flex items-center gap-4">
      <span class="text-xs text-[var(--text-secondary)] w-20">Context</span>
      <div class="flex items-center gap-1.5 p-0.5 bg-[var(--surface-highlight)] rounded-full border border-[var(--border-light)]">
        {#each contextPresets as preset}
          {#if preset <= maxContext}
            <button
              class={`px-3 py-1 text-xs rounded-full transition ${contextLength === preset ? 'bg-[var(--text)] text-[var(--surface)]' : 'hover:bg-[var(--surface-highlight)] text-[var(--text-tertiary)] hover:text-[var(--text)]'}`}
              onclick={() => { localContextLength = preset; commitContext();}}
            >
              {preset >= 1024 ? `${Math.round(preset / 1024)}k` : preset}
            </button>
          {/if}
        {/each}
      </div>
      <input
        type="range"
        min="512"
        max={maxContext}
        value={localContextLength}
        oninput={(e) => { localContextLength = Number((e.target as HTMLInputElement).value);}}
        onchange={commitContext}
        class="flex-1 h-1 bg-[var(--border)] rounded-full appearance-none cursor-pointer accent-black dark:accent-white"
      />
      <span class="text-xs text-[var(--text-secondary)] w-12 text-right">{localContextLength >= 1024 ? `${Math.round(localContextLength/1024)}k` : localContextLength}</span>
    </div>

    <!-- Memory info -->
    <div class="text-xs text-[var(--text-muted)]">
      {memoryEstimate.ramNeededGb.toFixed(1)}G RAM{gpuLayers > 0 ? ` + ${memoryEstimate.gpuGb.toFixed(1)}G GPU` : ''}
    </div>

    <!-- Quick actions -->
    <div class="flex items-center gap-2">
      <button
        class="px-3 py-1.5 text-xs border border-[var(--border)] rounded-full transition hover:bg-[var(--surface-highlight)]"
        onclick={applyRecommendedPreset}
        disabled={!recommended}
      >
        Recommended
      </button>
    </div>

    <!-- Loading progress -->
    {#if appStore.localModelLoading}
      <div class="flex items-center gap-3">
        <div class="h-1 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
          <div class="h-full bg-[var(--text)] transition-all" style={`width: ${Math.max(8, appStore.localModelLoadProgress)}%`}></div>
        </div>
        <span class="text-xs text-[var(--text-secondary)]">{appStore.localModelLoadProgress}%</span>
      </div>
    {/if}

  </div>
  {:else}
  <!-- ==================== ADVANCED VIEW ==================== -->
  <div class="mb-3 grid gap-2 grid-cols-4">
  <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2">
  <div class="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]"><Layers3 class="h-3 w-3" /> Context</div>
  <div class="text-xs font-medium text-[var(--text)]">{maxContext.toLocaleString()}t</div>
  </div>
  <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2">
  <div class="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]"><Cpu class="h-3 w-3" /> CPU</div>
  <div class="text-xs font-medium text-[var(--text)]">{hardware ? `${hardware.physical_cores}C / ${hardware.cpu_threads}T` : '…'}</div>
  </div>
  <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2">
  <div class="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]"><MemoryStick class="h-3 w-3" /> RAM</div>
  <div class="text-xs font-medium text-[var(--text)]">{hardware ? `${hardware.total_ram_gb.toFixed(0)} GB` : '…'}</div>
  </div>
  <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2">
  <div class="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]"><Gauge class="h-3 w-3" /> GPU</div>
  <div class="truncate text-xs font-medium text-[var(--text)]">{hardware ? `${hardware.gpu_name || 'CPU only'}${hardware.vram_gb > 0 ? ` · ${hardware.vram_estimated ? '~' : ''}${hardware.vram_gb.toFixed(1)}G` : ''}` : '…'}</div>
  </div>
  </div>

  {#if hardware?.vram_estimated}
  <div class="-mt-1 mb-2 text-[11px] text-[var(--text-tertiary)]">GPU memory is estimated for integrated graphics; adjust GPU layers if startup fails.</div>
  {/if}

  <div class="mb-3 flex flex-wrap items-center gap-2">
  <button class="inline-flex items-center gap-1.5 rounded-full bg-[var(--text)] px-3 py-1.5 text-xs font-semibold text-[var(--surface)] transition hover:opacity-80 disabled:opacity-50" onclick={applyRecommendedPreset} disabled={!recommended}>
  <Sparkles class="h-3.5 w-3.5" />
  Apply recommended
  </button>
  <button class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)]" onclick={resetToSavedDefaults}>
  <RotateCcw class="h-3.5 w-3.5" />
  Reset
  </button>
  </div>

  <div class="grid gap-3 lg:grid-cols-[1.35fr_0.65fr]">
  <div class="space-y-3">
  <section class="rounded-lg border border-[var(--border)] p-3">
  <div class="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--text)] uppercase tracking-[0.12em]">
  <SlidersHorizontal class="h-3.5 w-3.5" />
  Core settings
  </div>

  <div class="mb-2.5 flex flex-wrap gap-1.5 p-0.5 bg-[var(--surface-highlight)] rounded-full border border-[var(--border-light)]">
  {#each contextPresets as preset}
  {#if preset <= maxContext}
  <button
  class={`rounded-full px-3 py-1.5 text-xs font-medium transition ${contextLength === preset ? 'bg-[var(--text)] text-[var(--surface)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]'}`}
  onclick={() => { localContextLength = preset; commitContext();}}
  >
  {preset >= 1024 ? `${Math.round(preset / 1024)}k` : preset}
  </button>
  {/if}
  {/each}
  </div>

  <div class="space-y-3">
  <label class="block space-y-1.5 text-sm">
  <div class="flex items-center justify-between gap-3">
  <span class="text-xs font-medium text-[var(--text-secondary)]">Context length</span>
  <input
  class="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs text-right outline-none transition text-[var(--text)] focus:border-[var(--border-strong)]"
  type="number"
  value={localContextLength}
  min="512"
  max={maxContext}
  oninput={(e) => { localContextLength = Number((e.target as HTMLInputElement).value);}}
  onchange={commitContext}
  inputmode="numeric"
  />
  </div>
  <input
  type="range"
  min="512"
  max={maxContext}
  value={localContextLength}
  oninput={(e) => { localContextLength = Number((e.target as HTMLInputElement).value);}}
  onchange={commitContext}
  class="w-full accent-black dark:accent-white"
  />
  </label>

  <label class="block space-y-1.5 text-sm">
  <div class="flex items-center justify-between gap-3">
  <span class="text-xs font-medium text-[var(--text-secondary)]">GPU layers</span>
  <input
  class="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs text-right outline-none transition text-[var(--text)] focus:border-[var(--border-strong)]"
  type="number"
  value={localGpuLayers}
  min="0"
  max={gpuLayersMax || 0}
  oninput={(e) => { localGpuLayers = Number((e.target as HTMLInputElement).value);}}
  onchange={commitGpuLayers}
  inputmode="numeric"
  />
  </div>
  <input
  type="range"
  min="0"
  max={gpuLayersMax || 0}
  value={localGpuLayers}
  oninput={(e) => { localGpuLayers = Number((e.target as HTMLInputElement).value);}}
  onchange={commitGpuLayers}
  class="w-full accent-black dark:accent-white"
  />
  </label>

  <div class="grid gap-3 md:grid-cols-2">
  <label class="space-y-1.5 text-sm">
  <span class="text-xs font-medium text-[var(--text-secondary)]">CPU threads</span>
  <input
  type="range"
  min="1"
  max={cpuThreadsMax}
  value={localCpuThreads}
  oninput={(e) => { localCpuThreads = Number((e.target as HTMLInputElement).value);}}
  onchange={commitCpuThreads}
  class="w-full accent-black dark:accent-white"
  />
  <input
  class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none transition text-[var(--text)] focus:border-[var(--border-strong)]"
  type="number"
  value={localCpuThreads}
  min="1"
  max={cpuThreadsMax}
  oninput={(e) => { localCpuThreads = Number((e.target as HTMLInputElement).value);}}
  onchange={commitCpuThreads}
  inputmode="numeric"
  />
  </label>
  <label class="space-y-1.5 text-sm">
  <span class="text-xs font-medium text-[var(--text-secondary)]">Batch size</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none transition text-[var(--text)] focus:border-[var(--border-strong)]" bind:value={appStore.localModelLoadBatchSize} inputmode="numeric" />
  </label>
  </div>
  </div>
  </section>

  <section class="rounded-lg border border-[var(--border)] p-3">
  <div class="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--text)] uppercase tracking-[0.12em]">
  <HardDrive class="h-3.5 w-3.5" />
  Memory estimate
  </div>
  <div class="grid gap-2 grid-cols-3">
  <div class="rounded-lg bg-[var(--surface-highlight)] px-2.5 py-2">
  <div class="text-[10px] uppercase tracking-[0.14em] text-[var(--text-tertiary)]">Total</div>
  <div class="mt-0.5 text-xs font-medium text-[var(--text)]">{memoryEstimate.totalGb.toFixed(2)} GB</div>
  </div>
  <div class="rounded-lg bg-[var(--surface-highlight)] px-2.5 py-2">
  <div class="text-[10px] uppercase tracking-[0.14em] text-[var(--text-tertiary)]">GPU</div>
  <div class="mt-0.5 text-xs font-medium text-[var(--text)]">{gpuLayers > 0 ? `${memoryEstimate.gpuGb.toFixed(2)} GB` : '--'}</div>
  </div>
  <div class="rounded-lg bg-[var(--surface-highlight)] px-2.5 py-2">
  <div class="text-[10px] uppercase tracking-[0.14em] text-[var(--text-tertiary)]">RAM</div>
  <div class="mt-0.5 text-xs font-medium text-[var(--text)]">{memoryEstimate.ramNeededGb.toFixed(2)} GB</div>
  </div>
  </div>

  <!-- RAM gauge bar -->
  {#if hardware}
  {@const totalRam = Number(hardware.total_ram_gb || 0)}
  {@const gpuUsage = memoryEstimate.gpuGb}
  {@const ramUsage = memoryEstimate.ramNeededGb}
  {@const usedTotal = gpuUsage + ramUsage}
  {@const overflows = usedTotal > totalRam}
  {@const barMax = overflows ? usedTotal : totalRam}
  {@const gpuPct = barMax > 0 ? (gpuUsage / barMax) * 100 : 0}
  {@const ramPct = barMax > 0 ? (ramUsage / barMax) * 100 : 0}
  {@const freeGb = Math.max(0, totalRam - usedTotal)}
  <div class="mt-3 space-y-1.5">
  <div class="flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
  <span>System RAM</span>
  <span>{totalRam.toFixed(1)} GB</span>
  </div>
  <div class="relative h-2.5 w-full overflow-hidden rounded-lg {overflows ? 'bg-error-bg' : 'bg-[var(--surface-highlight)]'}">
  {#if gpuUsage > 0}
  <div
  class="absolute inset-y-0 left-0 rounded-l-lg bg-[var(--text-secondary)]"
  style="width: {gpuPct}%"
  ></div>
  {/if}
  <div
  class="absolute inset-y-0 bg-[var(--text-tertiary)] {gpuUsage <= 0 ? 'rounded-l-lg' : ''} {!overflows && freeGb > 0 ? '' : 'rounded-r-lg'}"
  style="left: {gpuPct}%; width: {ramPct}%"
  ></div>
  {#if overflows}
  <div
   class="absolute inset-y-0 border-r-2 border-dashed border-[var(--text-muted)]"
   style="left: {(totalRam / barMax) * 100}%"
   ></div>
  {/if}
  </div>
  <div class="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-[var(--text-tertiary)]">
  {#if gpuUsage > 0}
  <span class="inline-flex items-center gap-1">
  <span class="inline-block h-2 w-2 rounded-lg bg-[var(--text-secondary)]"></span>
  GPU: {gpuUsage.toFixed(2)} GB
  </span>
  {/if}
  <span class="inline-flex items-center gap-1">
  <span class="inline-block h-2 w-2 rounded-lg bg-[var(--text-tertiary)]"></span>
  RAM: {ramUsage.toFixed(2)} GB
  </span>
  <span class="inline-flex items-center gap-1">
  <span class="inline-block h-2 w-2 rounded-lg bg-[var(--surface-highlight)]"></span>
  Free: {freeGb.toFixed(2)} GB
  </span>
  {#if overflows}
   <span class="font-medium text-[var(--text)]">⚠ Exceeds by {(usedTotal - totalRam).toFixed(2)} GB</span>
  {/if}
  </div>
  </div>

  <!-- VRAM gauge bar -->
  {#if gpuLayers > 0 && Number(hardware.vram_gb || 0) > 0}
  {@const totalVram = Number(hardware.vram_gb || 0)}
  {@const vramUsedPct = totalVram > 0 ? Math.min((gpuUsage / totalVram) * 100, 100) : 0}
  {@const vramOverflows = gpuUsage > totalVram}
  <div class="mt-3 space-y-1.5">
  <div class="flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
  <span>VRAM</span>
  <span>{gpuUsage.toFixed(2)} / {totalVram.toFixed(1)} GB ({vramUsedPct.toFixed(0)}%)</span>
  </div>
  <div class="relative h-2.5 w-full overflow-hidden rounded-lg {vramOverflows ? 'bg-[var(--surface-secondary)]' : 'bg-[var(--surface-highlight)]'}">
  <div
  class="absolute inset-y-0 left-0 rounded-l-lg bg-[var(--text-secondary)] {vramUsedPct >= 100 ? 'rounded-r-lg' : ''}"
  style="width: {vramUsedPct}%"
  ></div>
  </div>
  </div>
  {/if}
  {/if}

  {#if memoryEstimate.warnings.length}
   <div class={`mt-3 rounded-lg border px-3 py-2 text-sm ${memoryEstimate.compatible ? 'border-[var(--border)] bg-[var(--surface-highlight)] text-[var(--text)]' : 'border-[var(--border-strong)] bg-[var(--surface-secondary)] text-[var(--text)]'}`}>
  <div class="mb-1 flex items-center gap-2 font-medium">
  <AlertTriangle class="h-4 w-4" />
  {memoryEstimate.compatible ? 'Load may be tight' : 'Memory may be insufficient'}
  </div>
  <div class="space-y-1 text-xs">
  {#each memoryEstimate.warnings as warning}
  <div>{warning}</div>
  {/each}
  </div>
  </div>
  {/if}
  </section>

  <section class="rounded-lg border border-[var(--border)] p-3">
  <button class="flex w-full items-center justify-between gap-3 text-left text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text)]" onclick={() => (advancedOpen = !advancedOpen)}>
  <span class="inline-flex items-center gap-2">
  <BrainCircuit class="h-3.5 w-3.5" />
  Advanced
  </span>
  {#if advancedOpen}
  <ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />
  {:else}
  <ChevronRight class="h-3.5 w-3.5 text-[var(--text-muted)]" />
  {/if}
  </button>

  {#if advancedOpen}
  <div class="mt-3 space-y-3">
  <div class="grid gap-3 md:grid-cols-2">
  <label class="space-y-1.5 text-sm">
  <span class="text-xs font-medium text-[var(--text-secondary)]">Runtime path</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none transition text-[var(--text)] focus:border-[var(--border-strong)]" bind:value={appStore.localModelLoadRuntimePath} placeholder="Optional llama-server path" />
  </label>
  <label class="space-y-1.5 text-sm">
  <span class="text-xs font-medium text-[var(--text-secondary)]">Parallel slots</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none transition text-[var(--text)] focus:border-[var(--border-strong)]" bind:value={appStore.localModelLoadParallel} inputmode="numeric" />
  </label>
  </div>

  <div class="grid gap-3 md:grid-cols-2">
  <label class="space-y-1.5 text-sm">
  <span class="text-xs font-medium text-[var(--text-secondary)]">Cache type K</span>
  <select class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none transition text-[var(--text)] focus:border-[var(--border-strong)]" bind:value={appStore.localModelLoadCacheTypeK}>
  {#each cacheTypes as type}
  <option value={type}>{type}</option>
  {/each}
  </select>
  </label>
  <label class="space-y-1.5 text-sm">
  <span class="text-xs font-medium text-[var(--text-secondary)]">Cache type V</span>
  <select class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none transition text-[var(--text)] focus:border-[var(--border-strong)]" bind:value={appStore.localModelLoadCacheTypeV}>
  {#each cacheTypes as type}
  <option value={type}>{type}</option>
  {/each}
  </select>
  </label>
  </div>

  <div class="grid gap-3 md:grid-cols-3">
  <label class="space-y-1.5 text-sm">
  <span class="text-xs font-medium text-[var(--text-secondary)]">Seed</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none transition text-[var(--text)] focus:border-[var(--border-strong)]" bind:value={appStore.localModelLoadSeed} inputmode="numeric" placeholder="Optional" />
  </label>
  <label class="space-y-1.5 text-sm">
  <span class="text-xs font-medium text-[var(--text-secondary)]">RoPE base</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none transition text-[var(--text)] focus:border-[var(--border-strong)]" bind:value={appStore.localModelLoadRopeFreqBase} inputmode="decimal" placeholder="Optional" />
  </label>
  <label class="space-y-1.5 text-sm">
  <span class="text-xs font-medium text-[var(--text-secondary)]">RoPE scale</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none transition text-[var(--text)] focus:border-[var(--border-strong)]" bind:value={appStore.localModelLoadRopeFreqScale} inputmode="decimal" placeholder="Optional" />
  </label>
  </div>

  <div class="grid gap-2 md:grid-cols-2">
  <label class="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
  <span>Flash attention</span>
  <input type="checkbox" bind:checked={appStore.localModelLoadFlashAttention} />
  </label>
  <label class="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
  <span>Offload KV cache</span>
  <input type="checkbox" bind:checked={appStore.localModelLoadOffloadKvCache} />
  </label>
  <label class="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
  <span>Keep in memory</span>
  <input type="checkbox" bind:checked={appStore.localModelLoadKeepInMemory} />
  </label>
  <label class="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
  <span>Memory map file</span>
  <input type="checkbox" bind:checked={appStore.localModelLoadMmap} />
  </label>
  </div>
  </div>
  {/if}
  </section>
  </div>

  <div class="space-y-3">
  <section class="rounded-lg border border-[var(--border)] p-3">
  <div class="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-tertiary)]">Summary</div>
  <div class="space-y-1.5 text-xs text-[var(--text-secondary)]">
  <div class="flex items-center justify-between gap-3"><span>Model max context</span><span class="font-medium text-[var(--text)]">{maxContext.toLocaleString()}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Context</span><span class="font-medium text-[var(--text)]">{contextLength.toLocaleString()}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Backend</span><span class="font-medium text-[var(--text)]">{recommended?.backend || hardware?.gpu_backend || 'cpu'}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Device</span><span class="font-medium text-[var(--text)]">{recommended?.selected_device || 'auto'}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Binary backends</span><span class="font-medium text-[var(--text)]">{recommended?.available_backends?.join(', ') || 'unknown'}</span></div>
  <div class="flex items-center justify-between gap-3"><span>GPU layers</span><span class="font-medium text-[var(--text)]">{gpuLayers}</span></div>
  <div class="flex items-center justify-between gap-3"><span>CPU threads</span><span class="font-medium text-[var(--text)]">{cpuThreads}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Batch size</span><span class="font-medium text-[var(--text)]">{batchSize}</span></div>
  </div>
  </section>

  <section class="rounded-lg border border-[var(--border)] p-3">
  <label class="flex items-start gap-2.5 text-xs text-[var(--text-secondary)]">
  <input type="checkbox" class="mt-0.5" bind:checked={appStore.localModelRememberSettings} />
  <span>
  <span class="block font-medium text-[var(--text)]">Remember settings</span>
  <span class="text-[var(--text-tertiary)]">Reuse this profile next time.</span>
  </span>
  </label>
  </section>

  {#if appStore.localModelLoading}
  <section class="rounded-lg border border-[var(--border)] p-3">
  <div class="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--text)]">
  <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
  Loading model…
  </div>
  <div class="h-1.5 overflow-hidden rounded-full bg-[var(--surface-highlight)]">
  <div class="h-full rounded-full bg-[var(--primary)] transition-all" style={`width: ${Math.max(8, appStore.localModelLoadProgress)}%`}></div>
  </div>
  {#if appStore.localModelLoadPhase}
  <div class="mt-1.5 text-[11px] text-[var(--text-tertiary)]">{appStore.localModelLoadPhase}</div>
  {/if}
  </section>
  {/if}
  </div>
  </div>
  {/if}

  <div class="mt-5 flex items-center justify-between gap-3">
    <div>
      {#if isAnyModelLoaded && !appStore.localModelLoading}
        <button
          class="px-3 py-1.5 text-xs border border-[var(--border)] rounded-full transition hover:bg-[var(--surface-highlight)]"
          onclick={async () => { await appStore.stopLocalModel(); appStore.closeLocalModelLoadDialog();}}
        >
          Unload
        </button>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      {#if appStore.localModelLoading}
        <button
          class="px-3 py-1.5 text-xs border border-[var(--border)] rounded-full transition bg-[var(--text)] text-[var(--surface)]"
          onclick={async () => { await appStore.stopLocalModel(); appStore.closeLocalModelLoadDialog();}}
        >
          Stop
        </button>
      {:else}
        <button
          class="px-3 py-1.5 text-xs border border-[var(--border)] rounded-full transition hover:bg-[var(--surface-highlight)]"
          onclick={() => appStore.closeLocalModelLoadDialog()}
        >
          Cancel
        </button>
        <button
          class="px-4 py-1.5 text-xs rounded-full transition bg-[var(--text)] text-[var(--surface)] hover:opacity-80"
          onclick={() => appStore.confirmLocalModelLoad()}
          disabled={!memoryEstimate.compatible}
        >
          Load
        </button>
      {/if}
    </div>
  </div>
 </div>
 </div>
{/if}
