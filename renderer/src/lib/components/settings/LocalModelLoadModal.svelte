<svelte:options runes={true} />

<script lang="ts">
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import type { GgufMeta, HardwareInfo, RecommendedSettings } from '$lib/types/tauri';
  import { AlertTriangle, BrainCircuit, ChevronDown, ChevronRight, Cpu, Gauge, HardDrive, Layers3, LoaderCircle, MemoryStick, RotateCcw, SlidersHorizontal, Sparkles, X } from 'lucide-svelte';
  import { untrack } from 'svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { getHardwareLimits } from '$lib/services/hardware';
  import { getGgufMetadata } from '$lib/services/models';
  import { getRecommendedSettings } from '$lib/services/runtime';
  import { getInstalledRuntimes, pickMmprojFile } from '$lib/services/files';
  import { formatContextLength, formatModelParameterCount } from '$lib/utils/local-models';
  import { formatBytes } from '$lib/utils/format';
  import { Select } from '$lib/components/ui';

  const contextPresets = [4096, 8192, 16384, 32768];
  const cacheTypes = ['f16', 'q8_0', 'q4_0'];
  const splitModes = ['', 'layer', 'row', 'tensor', 'none'];
  const mtpDraftNMaxPresets = [2, 3, 4, 6, 8];

  let metadata = $state<GgufMeta | null>(null);
  let hardware = $state<HardwareInfo | null>(null);
  let recommended = $state<RecommendedSettings | null>(null);
  let advancedOpen = $state(false);
  let loadingMeta = $state(false);
  let viewMode = $state<'simple' | 'advanced'>('simple');

  const target = $derived(appStore.localModelLoadTarget);
  const isAnyModelLoaded = $derived(Boolean(modelsStore.status?.active_model));
  const maxContext = $derived(Math.max(512, Number(metadata?.context_length || target?.context_length || 4096)));
  const blockCount = $derived(Math.max(0, Number(metadata?.block_count || 0)));
  // `expert_count` is present in GGUF metadata only for MoE architectures.
  const expertCount = $derived(Math.max(0, Number(metadata?.expert_count || 0)));
  const isMoeModel = $derived(expertCount > 0);
  const parameterCount = $derived(Number(metadata?.parameter_count || 0));
  const fileSizeBytes = $derived(Number(metadata?.file_size_bytes || 0));
  const displayArchitecture = $derived(String(metadata?.architecture || target?.architecture || '').trim());
  const displayQuantization = $derived(String(metadata?.quantization_name || target?.quantization_name || '').trim());
  const displayParameterLabel = $derived(formatModelParameterCount(parameterCount || target?.parameter_count || 0));
  const displayContextLabel = $derived(formatContextLength(maxContext || target?.context_length || 0));
  const displaySizeLabel = $derived(fileSizeBytes > 0 ? formatBytes(fileSizeBytes) : String(target?.size_label || '').trim());
  const headerMetaLine = $derived.by(() => {
    const parts = [
      displayArchitecture,
      displayQuantization,
      displayParameterLabel,
      displaySizeLabel,
      displayContextLabel ? `${displayContextLabel} context` : ''
    ].filter(Boolean);
    return parts.join(' / ');
  });
  const gpuLayersMax = $derived.by(() => {
    const current = Number(appStore.localModelLoadGpuLayers || 0);
    if (blockCount > 0) return Math.max(blockCount, current);
    return Math.max(80, current);
  });
  const cpuThreadsMax = $derived(Math.max(1, Number(hardware?.cpu_threads || navigator.hardwareConcurrency || 4)));

  // Local slider state — decoupled from store to avoid re-renders on every tick.
  // `*IsAuto` tracks whether the user has taken over from llama.cpp's --fit; the
  // slider still needs a concrete number to render while auto is in effect.
  let localContextLength = $state(Number(appStore.localModelLoadContextLength || 4096));
  let localGpuLayers = $state(Number(appStore.localModelLoadGpuLayers || 0));
  let localCpuThreads = $state(Number(appStore.localModelLoadCpuThreads || 4));
  let contextIsAuto = $state(!appStore.localModelLoadContextLength);
  let gpuLayersIsAuto = $state(!appStore.localModelLoadGpuLayers);

  // Clamped computed values from local state
  const contextLength = $derived(Math.max(512, Math.min(maxContext, localContextLength)));
  const gpuLayers = $derived(Math.max(0, Math.min(gpuLayersMax, localGpuLayers)));
  const cpuThreads = $derived(Math.max(1, Math.min(cpuThreadsMax, localCpuThreads)));
  const batchSize = $derived(Math.max(1, Number(appStore.localModelLoadBatchSize || 512)));

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
    const source = metadata?.chat_template_uses_tools ?? target?.chat_template_uses_tools;
    if (source === true) return { label: 'Supported', tone: 'text-fg' };
    if (source === false) return { label: 'Not supported', tone: 'text-fg-secondary' };
    if (!loadingMeta) return { label: 'Unknown', tone: 'text-fg-secondary' };
    return { label: 'Unknown', tone: 'text-fg-secondary' };
  });

  const thinkingSupport = $derived.by(() => {
    const supported = metadata?.chat_template_supports_thinking;
    if (supported === true) return { label: 'Supported', tone: 'text-fg' };
    if (supported === false) return { label: 'Not supported', tone: 'text-fg-secondary' };
    return { label: 'Unknown', tone: 'text-fg-secondary' };
  });
  const thinkingOn = $derived(!appStore.localModelLoadDisableThinking);
  const thinkingLockedOff = $derived(thinkingSupport.label === 'Not supported');

  const visionSupport = $derived.by(() => {
    if (appStore.localModelLoadMmprojPath) {
      return { label: 'Projector selected', tone: 'text-fg' };
    }
    return { label: 'Text only', tone: 'text-fg-secondary' };
  });
  const visionSelectedName = $derived(appStore.localModelLoadMmprojPath
    ? (appStore.localModelLoadMmprojPath.split(/[/\\]/).pop() || '')
    : '');

  const mtpSupport = $derived.by(() => {
    const builtIn = metadata?.has_mtp_layers === true
      || (target?.name || '').toLowerCase().includes('mtp');
    if (builtIn) return { label: 'Built-in MTP', tone: 'text-fg', allowToggle: true, requireDraft: false };
    if (metadata?.has_mtp_layers === false) return { label: 'Not supported', tone: 'text-fg-secondary', allowToggle: false, requireDraft: false };
    return { label: 'Unknown', tone: 'text-fg-secondary', allowToggle: true, requireDraft: true };
  });
  const mtpLockedOff = $derived(!mtpSupport.allowToggle);
  const mtpDraftSelected = $derived(!!appStore.localModelLoadMtpDraftPath);

  let projectorCandidates = $state<string[]>([]);
  let loadingProjectorCandidates = $state(false);

  $effect(() => {
    const modelPath = target?.path;
    if (!modelPath) {
      projectorCandidates = [];
      return;
    }
    loadingProjectorCandidates = true;
    void appStore.listProjectorCandidates(modelPath).then((list) => {
      projectorCandidates = list;
      loadingProjectorCandidates = false;
    });
  });

  async function pickProjector() {
    if (!target?.path) return;
    const selected = await pickMmprojFile();
    if (!selected) return;
    appStore.localModelLoadMmprojPath = selected;
  }

  async function clearProjector() {
    appStore.localModelLoadMmprojPath = '';
  }

  async function applyProjectorCandidate(path: string) {
    appStore.localModelLoadMmprojPath = path;
  }

  function applyRecommendedPreset() {
    if (!recommended) return;
    // Applying the preset is an explicit choice: it takes both sliders off auto.
    localContextLength = Number(recommended.context_length || contextLength);
    localGpuLayers = Number(recommended.gpu_layers || 0);
    localCpuThreads = Number(recommended.cpu_threads || cpuThreads);
    contextIsAuto = false;
    gpuLayersIsAuto = false;
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
    contextIsAuto = !storedCtx;
    gpuLayersIsAuto = !storedGpu;
    // Sliders show where auto is likely to land, but stay off until touched.
    localContextLength = Number(storedCtx || 4096);
    localGpuLayers = storedGpu ? Number(storedGpu) : gpuLayersMax;
    localCpuThreads = Number(storedCpu || 4);
  });

  // Commit local values to store (called on slider change / input blur).
  // Touching a control takes it off auto; '' in the store means auto.
  function commitContext() {
    contextIsAuto = false;
    appStore.localModelLoadContextLength = String(localContextLength);
  }
  function commitGpuLayers() {
    gpuLayersIsAuto = false;
    appStore.localModelLoadGpuLayers = String(localGpuLayers);
  }
  function commitCpuThreads() { appStore.localModelLoadCpuThreads = String(localCpuThreads); }

  function useAutoContext() {
    contextIsAuto = true;
    appStore.localModelLoadContextLength = '';
  }
  function useAutoGpuLayers() {
    gpuLayersIsAuto = true;
    appStore.localModelLoadGpuLayers = '';
  }

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
  <div class="aui-modal-backdrop z-[64]" role="dialog" aria-modal="true" transition:motionFade={{ duration: 150}}>
  <div class="aui-modal-surface load-modal-surface max-h-[92vh] max-w-4xl overflow-y-auto p-6" transition:flyAndScale={{ y: -12, start: 0.96, duration: 200}}>
 <div class="mb-5 flex items-start justify-between gap-4">
 <div class="min-w-0 space-y-2">
 <div>
 <div class="text-[15px] font-semibold leading-5 text-foreground">Load local model</div>
 <div class="mt-1 truncate text-[13px] leading-5 text-muted-foreground">{target.name}</div>
 </div>
 {#if headerMetaLine}
 <div class="text-[12px] leading-5 text-muted-foreground">{headerMetaLine}</div>
 {/if}
 </div>
 <button type="button" class="aui-icon-button size-8" onclick={() => appStore.closeLocalModelLoadDialog()} aria-label="Close load dialog">
 <X class="size-4" />
 </button>
 </div>

  <div class="info-card mb-5 grid gap-2 sm:grid-cols-2 text-[13px] leading-5 text-[var(--text-secondary)]">
  <div class="flex items-center justify-between gap-3"><span>Tools</span><span class={`font-medium ${toolSupport.tone}`}>{toolSupport.label}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Vision</span><span class={`font-medium ${visionSupport.tone}`}>{visionSupport.label}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Thinking</span><span class={`font-medium ${thinkingSupport.tone}`}>{thinkingSupport.label}</span></div>
  <div class="flex items-center justify-between gap-3"><span>MTP</span><span class={`font-medium ${mtpSupport.tone}`}>{mtpSupport.label}</span></div>
  </div>

 <!-- Runtime missing warning -->
 {#if hasRuntime === false}
   <div class="runtime-warning mb-4 flex items-start gap-3 rounded-lg bg-[var(--surface)] px-4 py-3">
  <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
  <div class="flex-1 min-w-0">
  <p class="text-[13px] font-medium text-[var(--text)]">Runtime not installed</p>
  <p class="mt-0.5 text-[12px] text-[var(--text-secondary)]">The llama.cpp runtime is required to run local models. Install it first.</p>
  </div>
   <button
   class="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-[var(--primary)] px-3.5 py-1.5 text-[12px] font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
   onclick={() => { appStore.closeLocalModelLoadDialog(); appStore.modelManagerOpenSection = 'runtime'; appStore.modelManagerOpen = true;}}
   >
  Install Runtime
  </button>
  </div>
 {/if}

   <!-- View mode toggle -->
   <div class="mb-4 flex items-center gap-3">
   <div class="flex items-center rounded-full bg-[var(--muted)] p-[3px]">
   <button class={`rounded-full px-3 py-1.5 text-[12px] font-medium transition ${viewMode === 'simple' ? 'bg-[var(--surface-active)] text-[var(--text)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'}`} onclick={() => (viewMode = 'simple')}>Simple</button>
   <button class={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition ${viewMode === 'advanced' ? 'bg-[var(--surface-active)] text-[var(--text)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'}`} onclick={() => (viewMode = 'advanced')}>
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
  <div class="simple-view space-y-5">

    <!-- GPU layers -->
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-3">
        <span class="text-[13px] font-medium text-[var(--text)]">GPU layers</span>
        <span class="text-[13px] text-[var(--text-secondary)]">{gpuLayersIsAuto ? 'Auto' : gpuLayers}</span>
      </div>
      <div class="flex items-center gap-3">
      <div class="flex items-center gap-1 rounded-full bg-[var(--muted)] p-[3px]">
        <button
          class={`rounded-full px-3 py-1.5 text-[12px] transition ${gpuLayersIsAuto ? 'bg-[var(--surface-active)] text-[var(--text)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'}`}
          onclick={useAutoGpuLayers}
          title="Let llama.cpp fit the model to available VRAM"
        >
          Auto
        </button>
        <button
          class={`rounded-full px-3 py-1.5 text-[12px] transition ${!gpuLayersIsAuto && gpuLayers === gpuLayersMax ? 'bg-[var(--surface-active)] text-[var(--text)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'}`}
          onclick={() => { localGpuLayers = gpuLayersMax; commitGpuLayers(); }}
        >
          All ({gpuLayersMax})
        </button>
        <button
          class={`rounded-full px-3 py-1.5 text-[12px] transition ${!gpuLayersIsAuto && gpuLayers === 0 ? 'bg-[var(--surface-active)] text-[var(--text)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'}`}
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
        class="flex-1 h-1 bg-[var(--border)] rounded-full appearance-none cursor-pointer accent-black dark:accent-white {gpuLayersIsAuto ? 'opacity-50' : ''}"
      />
      </div>
    </div>

    <!-- Context length -->
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-3">
        <span class="text-[13px] font-medium text-[var(--text)]">Context length</span>
        <span class="text-[13px] text-[var(--text-secondary)]">
          {contextIsAuto ? 'Auto' : (localContextLength >= 1024 ? `${Math.round(localContextLength/1024)}k` : localContextLength)}
        </span>
      </div>
      <div class="flex items-center gap-3">
      <div class="flex flex-wrap items-center gap-1 rounded-full bg-[var(--muted)] p-[3px]">
        <button
          class={`rounded-full px-3 py-1.5 text-[12px] transition ${contextIsAuto ? 'bg-[var(--surface-active)] text-[var(--text)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'}`}
          onclick={useAutoContext}
          title="Use the model's trained context, reduced to fit memory"
        >
          Auto
        </button>
        {#each contextPresets as preset}
          {#if preset <= maxContext}
            <button
              class={`rounded-full px-3 py-1.5 text-[12px] transition ${!contextIsAuto && contextLength === preset ? 'bg-[var(--surface-active)] text-[var(--text)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'}`}
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
        class="flex-1 h-1 bg-[var(--border)] rounded-full appearance-none cursor-pointer accent-black dark:accent-white {contextIsAuto ? 'opacity-50' : ''}"
      />
      </div>
    </div>

    <!-- MoE expert offload — only meaningful on mixture-of-experts models -->
    {#if isMoeModel}
      <div class="rounded-lg bg-[var(--surface)] px-3 py-2.5">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-[13px] font-medium text-[var(--text)]">Keep experts on CPU</div>
            <div class="text-[11px] text-[var(--text-tertiary)]">
              Frees VRAM for attention layers. Often the difference between this {expertCount}-expert model running or not.
            </div>
          </div>
          <label class="relative inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
            <input
              type="checkbox"
              class="peer sr-only"
              checked={appStore.localModelLoadCpuMoe}
              onchange={(e) => { appStore.localModelLoadCpuMoe = (e.currentTarget as HTMLInputElement).checked; }}
            />
            <span class="h-4 w-7 rounded-full bg-[var(--surface-hover)] transition peer-checked:bg-[var(--primary)]"></span>
            <span class="absolute left-0.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[var(--text-muted)] transition peer-checked:translate-x-3.5 peer-checked:bg-[var(--primary-fg)]"></span>
            <span class="text-[11px] font-semibold">{appStore.localModelLoadCpuMoe ? 'All' : 'Off'}</span>
          </label>
        </div>
        {#if appStore.localModelLoadCpuMoe}
          <div class="mt-2 flex items-center gap-2">
            <span class="text-[11px] text-[var(--text-tertiary)]">Or offload only the first N layers' experts:</span>
            <input
              class="w-20 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[12px] text-[var(--text)] outline-none focus:border-[var(--border-hover)]"
              type="number"
              min="0"
              max={blockCount || 999}
              bind:value={appStore.localModelLoadNCpuMoe}
              placeholder="all"
              inputmode="numeric"
            />
          </div>
        {/if}
      </div>
    {/if}

    <!-- Thinking toggle -->
    <div class="flex items-center justify-between gap-3 rounded-lg bg-[var(--surface)] px-3 py-2">
      <div>
        <div class="text-[13px] font-medium text-[var(--text)]">Thinking</div>
          <div class="text-[11px] text-[var(--text-tertiary)]">Lets the model show a thinking block before answering.</div>
      </div>
      <label class="relative inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
        <input
          type="checkbox"
          class="peer sr-only"
          checked={thinkingOn}
          disabled={thinkingLockedOff}
          onchange={(e) => { appStore.localModelLoadDisableThinking = !(e.currentTarget as HTMLInputElement).checked; }}
        />
        <span class="h-4 w-7 rounded-full bg-[var(--surface-hover)] transition peer-checked:bg-[var(--primary)] peer-disabled:opacity-50"></span>
        <span class="absolute left-0.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[var(--text-muted)] transition peer-checked:translate-x-3.5 peer-checked:bg-[var(--primary-fg)]"></span>
        <span class="text-[11px] font-semibold">{thinkingOn ? 'On' : 'Off'}</span>
      </label>
    </div>

    <!-- Vision projector selector -->
    <div class="rounded-lg bg-[var(--surface)] px-3 py-2.5">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-[13px] font-medium text-[var(--text)]">Vision projector</div>
          <div class="text-[11px] text-[var(--text-tertiary)]">{visionSelectedName || 'Text only — pick a mmproj to enable vision.'}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          {#if visionSelectedName}
            <button type="button" class="rounded-full px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={clearProjector}>Clear</button>
            <button type="button" class="rounded-full bg-[var(--primary)] px-3.5 py-1.5 text-[12px] font-semibold text-[var(--primary-fg)] transition hover:opacity-90" onclick={pickProjector}>Change</button>
          {:else}
            <button type="button" class="rounded-full bg-[var(--primary)] px-3.5 py-1.5 text-[12px] font-semibold text-[var(--primary-fg)] transition hover:opacity-90" onclick={pickProjector}>Select projector</button>
          {/if}
        </div>
      </div>
      {#if projectorCandidates.length > 0 && !visionSelectedName}
        <div class="mt-2 flex flex-wrap gap-1.5">
          {#each projectorCandidates as candidate}
            {@const candidateName = candidate.split(/[/\\]/).pop() || ''}
            <button type="button" class="rounded-full border border-[var(--border)] bg-[var(--background)] px-3 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={() => applyProjectorCandidate(candidate)} title={candidate}>
              {candidateName}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- MTP toggle -->
    <div class="rounded-lg bg-[var(--surface)] px-3 py-2.5">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-[13px] font-medium text-[var(--text)]">MTP (speculative decoding)</div>
          <div class="text-[11px] text-[var(--text-tertiary)]">{mtpSupport.label === 'Built-in MTP' ? 'Built-in MTP head detected.' : 'Speculative decoding via an MTP draft head.'}</div>
        </div>
        <label class="relative inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
          <input
            type="checkbox"
            class="peer sr-only"
            checked={appStore.localModelLoadMtpEnabled}
            disabled={mtpLockedOff || (!mtpDraftSelected && mtpSupport.requireDraft)}
            onchange={(e) => { appStore.localModelLoadMtpEnabled = (e.currentTarget as HTMLInputElement).checked; }}
          />
          <span class="h-4 w-7 rounded-full bg-[var(--surface-hover)] transition peer-checked:bg-[var(--primary)] peer-disabled:opacity-50"></span>
          <span class="absolute left-0.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[var(--text-muted)] transition peer-checked:translate-x-3.5 peer-checked:bg-[var(--primary-fg)]"></span>
          <span class="text-[11px] font-semibold">{appStore.localModelLoadMtpEnabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      {#if mtpSupport.requireDraft && appStore.localModelLoadMtpEnabled}
        <div class="mt-2 space-y-1.5">
          <div class="text-[11px] text-[var(--text-tertiary)]">Draft head (MTP). Required when the target model does not include MTP layers.</div>
          <div class="flex flex-wrap items-center gap-2">
            <input
              class="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[12px] text-[var(--text)] outline-none focus:border-[var(--border-hover)]"
              type="text"
              bind:value={appStore.localModelLoadMtpDraftPath}
              placeholder="C:/models/qwen3.6-mtp-draft.gguf"
            />
            <Select
              value={appStore.localModelLoadMtpDraftNMax}
              onchange={(value) => { appStore.localModelLoadMtpDraftNMax = value; }}
              options={[
                { value: '', label: 'n-max' },
                ...mtpDraftNMaxPresets.map((preset) => ({ value: String(preset), label: String(preset) })),
              ]}
              class="h-8 w-24 text-xs"
              aria-label="MTP draft max tokens"
            />
          </div>
        </div>
      {/if}
    </div>

    <!-- Memory info -->
    <div class="text-[13px] text-[var(--text-secondary)]">
      {memoryEstimate.ramNeededGb.toFixed(1)}G RAM{gpuLayers > 0 ? ` + ${memoryEstimate.gpuGb.toFixed(1)}G GPU` : ''}
    </div>

    <!-- Quick actions -->
    <div class="flex items-center gap-2">
      <button
        class="rounded-full bg-[var(--primary)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
        onclick={applyRecommendedPreset}
        disabled={!recommended}
      >
        Apply recommended
      </button>
    </div>

    <!-- Loading progress — phases come from llama-server's own startup log -->
    {#if appStore.localModelLoading}
      <div class="space-y-1.5">
        <div class="flex items-center gap-3">
          <div class="h-1 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
            <div class="h-full bg-[var(--primary)] transition-all" style={`width: ${Math.max(8, appStore.localModelLoadProgress)}%`}></div>
          </div>
          <span class="text-[12px] text-[var(--text-secondary)]">{appStore.localModelLoadProgress}%</span>
        </div>
        {#if appStore.localModelLoadPhase}
          <div class="text-[11px] text-[var(--text-tertiary)]">{appStore.localModelLoadPhase}</div>
        {/if}
      </div>
    {/if}

  </div>
  {:else}
  <!-- ==================== ADVANCED VIEW ==================== -->
  <div class="mb-4 grid gap-2 grid-cols-2 lg:grid-cols-4">
  <div class="rounded-lg bg-[var(--surface)] px-3 py-3">
  <div class="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]"><Layers3 class="h-3 w-3" /> Context</div>
  <div class="text-[13px] font-medium text-[var(--text)]">{maxContext.toLocaleString()}t</div>
  </div>
  <div class="rounded-lg bg-[var(--surface)] px-3 py-3">
  <div class="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]"><Cpu class="h-3 w-3" /> CPU</div>
  <div class="text-[13px] font-medium text-[var(--text)]">{hardware ? `${hardware.physical_cores}C / ${hardware.cpu_threads}T` : '…'}</div>
  </div>
  <div class="rounded-lg bg-[var(--surface)] px-3 py-3">
  <div class="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]"><MemoryStick class="h-3 w-3" /> RAM</div>
  <div class="text-[13px] font-medium text-[var(--text)]">{hardware ? `${hardware.total_ram_gb.toFixed(0)} GB` : '…'}</div>
  </div>
  <div class="rounded-lg bg-[var(--surface)] px-3 py-3">
  <div class="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]"><Gauge class="h-3 w-3" /> GPU</div>
  <div class="truncate text-[13px] font-medium text-[var(--text)]">{hardware ? `${hardware.gpu_name || 'CPU only'}${hardware.vram_gb > 0 ? ` · ${hardware.vram_estimated ? '~' : ''}${hardware.vram_gb.toFixed(1)}G` : ''}` : '…'}</div>
  </div>
  </div>

  {#if hardware?.vram_estimated}
  <div class="-mt-1 mb-2 text-[11px] text-[var(--text-tertiary)]">GPU memory is estimated for integrated graphics; adjust GPU layers if startup fails.</div>
  {/if}

  <div class="mb-4 flex flex-wrap items-center gap-2">
  <button class="inline-flex items-center gap-1.5 rounded-full bg-[var(--primary)] px-3.5 py-1.5 text-[12px] font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" onclick={applyRecommendedPreset} disabled={!recommended}>
  <Sparkles class="h-3.5 w-3.5" />
  Apply recommended
  </button>
  <button class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={resetToSavedDefaults}>
  <RotateCcw class="h-3.5 w-3.5" />
  Reset
  </button>
  </div>

  <div class="grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
  <div class="space-y-3">
   <section class="rounded-lg bg-[var(--surface)] p-4">
  <div class="mb-3 flex items-center gap-2 text-[12px] font-semibold text-[var(--text)] uppercase tracking-[0.12em]">
  <SlidersHorizontal class="h-3.5 w-3.5" />
  Core settings
  </div>

   <div class="mb-2.5 flex flex-wrap gap-1 rounded-full bg-[var(--background)] p-[3px]">
  {#each contextPresets as preset}
  {#if preset <= maxContext}
  <button
   class={`rounded-full px-3 py-1.5 text-[12px] font-medium transition ${contextLength === preset ? 'bg-[var(--surface-active)] text-[var(--text)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'}`}
  onclick={() => { localContextLength = preset; commitContext();}}
  >
  {preset >= 1024 ? `${Math.round(preset / 1024)}k` : preset}
  </button>
  {/if}
  {/each}
  </div>

  <div class="space-y-3">
  <label class="block space-y-2 text-sm">
  <div class="flex items-center justify-between gap-3">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">Context length</span>
  <input
  class="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-right outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]"
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

  <label class="block space-y-2 text-sm">
  <div class="flex items-center justify-between gap-3">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">GPU layers</span>
  <input
  class="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-right outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]"
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
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">CPU threads</span>
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
  class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[14px] outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]"
  type="number"
  value={localCpuThreads}
  min="1"
  max={cpuThreadsMax}
  oninput={(e) => { localCpuThreads = Number((e.target as HTMLInputElement).value);}}
  onchange={commitCpuThreads}
  inputmode="numeric"
  />
  </label>
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">Batch size</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[14px] outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]" bind:value={appStore.localModelLoadBatchSize} inputmode="numeric" />
  </label>
  </div>
  </div>
  </section>

   <section class="rounded-lg bg-[var(--surface)] p-4">
  <div class="mb-3 flex items-center gap-2 text-[12px] font-semibold text-[var(--text)] uppercase tracking-[0.12em]">
  <HardDrive class="h-3.5 w-3.5" />
  Memory estimate
  </div>
  <div class="grid gap-2 grid-cols-3">
  <div class="rounded-lg bg-[var(--surface-hover)] px-2.5 py-2">
  <div class="text-[10px] uppercase tracking-[0.14em] text-[var(--text-tertiary)]">Total</div>
  <div class="mt-0.5 text-xs font-medium text-[var(--text)]">{memoryEstimate.totalGb.toFixed(2)} GB</div>
  </div>
  <div class="rounded-lg bg-[var(--surface-hover)] px-2.5 py-2">
  <div class="text-[10px] uppercase tracking-[0.14em] text-[var(--text-tertiary)]">GPU</div>
  <div class="mt-0.5 text-xs font-medium text-[var(--text)]">{gpuLayers > 0 ? `${memoryEstimate.gpuGb.toFixed(2)} GB` : '--'}</div>
  </div>
  <div class="rounded-lg bg-[var(--surface-hover)] px-2.5 py-2">
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
  <div class="relative h-2.5 w-full overflow-hidden rounded-lg {overflows ? 'bg-error-bg' : 'bg-[var(--surface-hover)]'}">
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
  <span class="inline-block h-2 w-2 rounded-lg bg-[var(--surface-hover)]"></span>
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
  <div class="relative h-2.5 w-full overflow-hidden rounded-lg {vramOverflows ? 'bg-[var(--surface)]' : 'bg-[var(--surface-hover)]'}">
  <div
  class="absolute inset-y-0 left-0 rounded-l-lg bg-[var(--text-secondary)] {vramUsedPct >= 100 ? 'rounded-r-lg' : ''}"
  style="width: {vramUsedPct}%"
  ></div>
  </div>
  </div>
  {/if}
  {/if}

  {#if memoryEstimate.warnings.length}
    <div class={`mt-3 rounded-lg px-3 py-2 text-sm ${memoryEstimate.compatible ? 'bg-[var(--background)] text-[var(--text)]' : 'bg-error-bg text-error'}`}>
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

   <section class="rounded-lg bg-[var(--surface)] p-4">
  <button class="advanced-toggle flex w-full items-center justify-between gap-3 text-left text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--text)]" onclick={() => (advancedOpen = !advancedOpen)}>
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
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">Runtime path</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]" bind:value={appStore.localModelLoadRuntimePath} placeholder="Optional llama-server path" />
  </label>
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">Parallel slots</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]" bind:value={appStore.localModelLoadParallel} inputmode="numeric" />
  </label>
  </div>

  <div class="grid gap-3 md:grid-cols-2">
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">Cache type K</span>
  <Select
    class="h-10 w-full text-[13px]"
    bind:value={appStore.localModelLoadCacheTypeK}
    options={cacheTypes.map((type) => ({ value: type, label: type }))}
  />
  </label>
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">Cache type V</span>
  <Select
    class="h-10 w-full text-[13px]"
    bind:value={appStore.localModelLoadCacheTypeV}
    options={cacheTypes.map((type) => ({ value: type, label: type }))}
  />
  </label>
  </div>

  <div class="grid gap-3 md:grid-cols-3">
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">Seed</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]" bind:value={appStore.localModelLoadSeed} inputmode="numeric" placeholder="Optional" />
  </label>
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">RoPE base</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]" bind:value={appStore.localModelLoadRopeFreqBase} inputmode="decimal" placeholder="Optional" />
  </label>
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">RoPE scale</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]" bind:value={appStore.localModelLoadRopeFreqScale} inputmode="decimal" placeholder="Optional" />
  </label>
  </div>

  <div class="grid gap-3 md:grid-cols-3">
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">Prompt cache (MB)</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]" bind:value={appStore.localModelLoadCacheRamMb} inputmode="numeric" placeholder="8192" />
  </label>
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">Cache reuse</span>
  <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]" bind:value={appStore.localModelLoadCacheReuse} inputmode="numeric" placeholder="0" />
  </label>
  <label class="space-y-2 text-sm">
  <span class="text-[13px] font-medium text-[var(--text-secondary)]">Split mode</span>
  <Select
    class="h-10 w-full text-[13px]"
    bind:value={appStore.localModelLoadSplitMode}
    options={splitModes.map((mode) => ({ value: mode, label: mode || 'auto' }))}
  />
  </label>
  </div>

  <div class="grid gap-2 md:grid-cols-2">
   <label class="flex items-center justify-between gap-3 rounded-lg bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--text-secondary)]">
  <span>Flash attention</span>
  <input type="checkbox" bind:checked={appStore.localModelLoadFlashAttention} />
  </label>
   <label class="flex items-center justify-between gap-3 rounded-lg bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--text-secondary)]">
  <span title="Keep the KV cache in VRAM. Turning this off frees VRAM at a large speed cost.">Offload KV cache</span>
  <input type="checkbox" bind:checked={appStore.localModelLoadOffloadKvCache} />
  </label>
   <label class="flex items-center justify-between gap-3 rounded-lg bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--text-secondary)]">
  <span>Keep in memory</span>
  <input type="checkbox" bind:checked={appStore.localModelLoadKeepInMemory} />
  </label>
   <label class="flex items-center justify-between gap-3 rounded-lg bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--text-secondary)]">
  <span>Memory map file</span>
  <input type="checkbox" bind:checked={appStore.localModelLoadMmap} />
  </label>
   <label class="flex items-center justify-between gap-3 rounded-lg bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--text-secondary)]">
  <span title="Drop the oldest turns when the context fills instead of failing the request.">Context shift</span>
  <input type="checkbox" bind:checked={appStore.localModelLoadContextShift} />
  </label>
   <label class="flex items-center justify-between gap-3 rounded-lg bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--text-secondary)]">
  <span title="Full-size sliding-window cache. Improves prompt reuse on Gemma-style models.">Full SWA cache</span>
  <input type="checkbox" bind:checked={appStore.localModelLoadSwaFull} />
  </label>
   <label class="flex items-center justify-between gap-3 rounded-lg bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--text-secondary)]">
  <span>Disable thinking</span>
  <input type="checkbox" bind:checked={appStore.localModelLoadDisableThinking} />
  </label>
  </div>
  </div>
  {/if}
  </section>
  </div>

  <div class="space-y-3">
   <section class="rounded-lg bg-[var(--surface)] p-4">
  <div class="mb-3 text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--text-tertiary)]">Summary</div>
  <div class="space-y-2 text-[13px] text-[var(--text-secondary)]">
  <div class="flex items-center justify-between gap-3"><span>Model max context</span><span class="font-medium text-[var(--text)]">{maxContext.toLocaleString()}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Context</span><span class="font-medium text-[var(--text)]">{contextIsAuto ? 'Auto (--fit)' : contextLength.toLocaleString()}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Tool template</span><span class="font-medium text-[var(--text)]">{toolSupport.label}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Vision projector</span><span class="font-medium text-[var(--text)]">{appStore.localModelLoadMmprojPath ? 'Detected' : 'Not found'}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Backend</span><span class="font-medium text-[var(--text)]">{recommended?.backend || hardware?.gpu_backend || 'cpu'}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Device</span><span class="font-medium text-[var(--text)]">{recommended?.selected_device || 'auto'}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Binary backends</span><span class="font-medium text-[var(--text)]">{recommended?.available_backends?.join(', ') || 'unknown'}</span></div>
  <div class="flex items-center justify-between gap-3"><span>GPU layers</span><span class="font-medium text-[var(--text)]">{gpuLayersIsAuto ? 'Auto (--fit)' : gpuLayers}</span></div>
  <div class="flex items-center justify-between gap-3"><span>CPU threads</span><span class="font-medium text-[var(--text)]">{cpuThreads}</span></div>
  <div class="flex items-center justify-between gap-3"><span>Batch size</span><span class="font-medium text-[var(--text)]">{batchSize}</span></div>
  </div>
  </section>

   <section class="rounded-lg bg-[var(--surface)] p-4">
  <label class="flex items-start gap-2.5 text-[13px] text-[var(--text-secondary)]">
  <input type="checkbox" class="mt-0.5" bind:checked={appStore.localModelRememberSettings} />
  <span>
  <span class="block font-medium text-[var(--text)]">Remember settings</span>
  <span class="text-[var(--text-tertiary)]">Reuse this profile next time.</span>
  </span>
  </label>
  </section>

  {#if appStore.localModelLoading}
   <section class="rounded-lg bg-[var(--surface)] p-4">
  <div class="mb-2 flex items-center gap-2 text-[12px] font-semibold text-[var(--text)]">
  <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
  Loading model…
  </div>
  <div class="h-1.5 overflow-hidden rounded-full bg-[var(--surface-hover)]">
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

  <div class="mt-6 flex items-center justify-between gap-3">
    <div>
      {#if isAnyModelLoaded && !appStore.localModelLoading}
        <button
          class="rounded-full px-3.5 py-2 text-[13px] text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          onclick={async () => { await appStore.stopLocalModel(); appStore.closeLocalModelLoadDialog();}}
        >
          Unload
        </button>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      {#if appStore.localModelLoading}
        <button
          class="rounded-full bg-[var(--primary)] px-4 py-2 text-[13px] font-medium text-[var(--primary-fg)] transition hover:opacity-90"
          onclick={async () => { await appStore.stopLocalModel(); appStore.closeLocalModelLoadDialog();}}
        >
          Stop
        </button>
      {:else}
        <button
          class="rounded-full px-3.5 py-2 text-[13px] text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          onclick={() => appStore.closeLocalModelLoadDialog()}
        >
          Cancel
        </button>
        <button
          class="rounded-full bg-[var(--primary)] px-4 py-2 text-[13px] font-medium text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
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

<style>
  .load-modal-surface {
    border: 1px solid var(--border);
    background: var(--background);
    box-shadow: var(--shadow-xl);
  }

  .info-card,
  .runtime-warning,
  .load-modal-surface section {
    border: 0 !important;
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: none;
  }

  .info-card {
    border-radius: var(--radius-xl);
    padding: 0.85rem 1rem;
  }

  .load-modal-surface button {
    position: relative;
    overflow: hidden;
  }

  .load-modal-surface .advanced-toggle {
    border: none !important;
    background: transparent !important;
    box-shadow: none !important;
    color: var(--text) !important;
  }

  .load-modal-surface .advanced-toggle:hover {
    background: transparent !important;
    filter: none !important;
    box-shadow: none !important;
  }

  :global(.dark) .load-modal-surface {
    background: var(--background);
    box-shadow: var(--shadow-xl);
  }

</style>
