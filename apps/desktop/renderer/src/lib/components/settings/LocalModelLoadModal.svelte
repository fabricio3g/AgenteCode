<svelte:options runes={true} />

<script lang="ts">
  import type { GgufMeta, HardwareInfo, RecommendedSettings } from '$lib/types/bridge';
  import { AlertTriangle, CircleCheck, Info, LoaderCircle, Sparkles } from 'lucide-svelte';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { getHardwareLimits } from '$lib/services/hardware';
  import { getGgufMetadata } from '$lib/services/models';
  import { getRecommendedSettings, previewLocalModelCommand } from '$lib/services/runtime';
  import { getInstalledRuntimes, pickMmprojFile } from '$lib/services/files';
  import { formatContextLength, formatModelParameterCount } from '$lib/utils/local-models';
  import { formatBytes } from '$lib/utils/format';
  import { Badge, Button, Dialog, Disclosure, SegmentedControl, Select, Switch } from '$lib/components/ui';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';

  /** Presets scale with the model's real trained context, not a hard cap. */
  const contextPresets = $derived.by(() => {
    const base = [4096, 8192, 16384, 32768, 65536, 131072];
    const presets = base.filter((preset) => preset < maxContext);
    // The model's own maximum is always offered as the last stop.
    if (maxContext >= 512) presets.push(maxContext);
    return presets;
  });
  const cacheTypes = ['f16', 'q8_0', 'q4_0'];
  const engineToggles = [
    ['flashAttention', 'localModelLoadFlashAttention'],
    ['offloadKv', 'localModelLoadOffloadKvCache'],
    ['keepInMemory', 'localModelLoadKeepInMemory'],
    ['mmap', 'localModelLoadMmap'],
    ['contextShift', 'localModelLoadContextShift'],
    ['swaFull', 'localModelLoadSwaFull']
  ] as const;
  const splitModes = ['', 'layer', 'row', 'tensor', 'none'];
  const mtpDraftNMaxPresets = [2, 3, 4, 6, 8];

  let metadata = $state<GgufMeta | null>(null);
  let hardware = $state<HardwareInfo | null>(null);
  let recommended = $state<RecommendedSettings | null>(null);
  let advancedOpen = $state(false);
  let loadingMeta = $state(false);

  const target = $derived(appStore.localModelLoadTarget);
  const loading = $derived(appStore.localModelLoading);
  const isAnyModelLoaded = $derived(Boolean(modelsStore.status?.active_model));
  const maxContext = $derived(Math.max(512, Number(metadata?.context_length || target?.context_length || 4096)));
  const blockCount = $derived(Math.max(0, Number(metadata?.block_count || 0)));
  // `expert_count` is present in GGUF metadata only for MoE architectures.
  const expertCount = $derived(Math.max(0, Number(metadata?.expert_count || 0)));
  const isMoeModel = $derived(expertCount > 0);
  const parameterCount = $derived(Number(metadata?.parameter_count || 0));
  const fileSizeBytes = $derived(Number(metadata?.file_size_bytes || 0));
  const headerMetaLine = $derived.by(() => {
    const context = formatContextLength(maxContext || target?.context_length || 0);
    return [
      String(metadata?.architecture || target?.architecture || '').trim(),
      String(metadata?.quantization_name || target?.quantization_name || '').trim(),
      formatModelParameterCount(parameterCount || target?.parameter_count || 0),
      fileSizeBytes > 0 ? formatBytes(fileSizeBytes) : String(target?.size_label || '').trim(),
      context ? $t('localLoad.contextMeta', { values: { n: context } }) : ''
    ].filter(Boolean).join(' · ');
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

  const contextLength = $derived(Math.max(512, Math.min(maxContext, localContextLength)));
  const gpuLayers = $derived(Math.max(0, Math.min(gpuLayersMax, localGpuLayers)));

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
    const compatible = !hardware || ramNeededGb <= Number(hardware.total_ram_gb || 0) * 0.95;
    return { totalGb, gpuGb, ramNeededGb, compatible };
  });

  /** One plain-language answer to "will this run, and how well?" */
  const fit = $derived.by((): { tone: 'success' | 'warning' | 'error' | 'neutral'; text: string } | null => {
    if (!hardware) return null;
    const vram = Number(hardware.vram_gb || 0);
    if (!memoryEstimate.compatible) return { tone: 'error', text: $t('localLoad.fitWontFit') };
    if (gpuLayersIsAuto) return { tone: 'neutral', text: $t('localLoad.fitAuto') };
    if (vram > 0 && memoryEstimate.gpuGb > vram * 0.95) return { tone: 'warning', text: $t('localLoad.fitOverVram') };
    if (memoryEstimate.ramNeededGb > Number(hardware.free_ram_gb || 0) * 0.9) return { tone: 'warning', text: $t('localLoad.fitTight') };
    if (gpuLayers === 0 || vram <= 0) return { tone: 'neutral', text: $t('localLoad.fitCpu') };
    if (gpuLayers < gpuLayersMax) return { tone: 'neutral', text: $t('localLoad.fitPartial') };
    return { tone: 'success', text: $t('localLoad.fitGpu') };
  });

  const meterRows = $derived.by(() => {
    if (!hardware) return [];
    const rows: Array<{ label: string; used: number; total: number }> = [];
    const vram = Number(hardware.vram_gb || 0);
    if (vram > 0 && gpuLayers > 0) rows.push({ label: $t('localLoad.meterGpu'), used: memoryEstimate.gpuGb, total: vram });
    rows.push({ label: $t('localLoad.meterRam'), used: memoryEstimate.ramNeededGb, total: Number(hardware.total_ram_gb || 0) });
    return rows;
  });

  const toolSupport = $derived(metadata?.chat_template_uses_tools ?? target?.chat_template_uses_tools);
  const thinkingSupport = $derived(metadata?.chat_template_supports_thinking);
  const thinkingLocked = $derived(thinkingSupport === false);
  // When the model's GGUF lost its chat template, the server gets one from a
  // downloaded sidecar or the built-in family template. Say so — otherwise a
  // repaired model reads as a normal one and a truly unsupported one reads
  // as a mystery.
  const templateFallbackNote = $derived.by(() => {
    const source = metadata?.chat_template_source;
    if (source === 'sidecar') return $t('localLoad.templateSidecar');
    if (source === 'builtin') {
      const family = metadata?.chat_template_family;
      return family ? $t('localLoad.templateRestoredFamily', { values: { family } }) : $t('localLoad.templateRestored');
    }
    if (source === 'none') return $t('localLoad.templateNone');
    return '';
  });

  const visionSelectedName = $derived(appStore.localModelLoadMmprojPath
    ? (appStore.localModelLoadMmprojPath.split(/[/\\]/).pop() || '')
    : '');

  const mtp = $derived.by(() => {
    const builtIn = metadata?.has_mtp_layers === true || (target?.name || '').toLowerCase().includes('mtp');
    if (builtIn) return { builtIn: true, allowToggle: true, requireDraft: false };
    if (metadata?.has_mtp_layers === false) return { builtIn: false, allowToggle: false, requireDraft: false };
    return { builtIn: false, allowToggle: true, requireDraft: true };
  });

  const capabilities = $derived([
    { label: $t('localLoad.capTools'), on: toolSupport === true, known: toolSupport != null },
    { label: $t('localLoad.capThinking'), on: thinkingSupport === true, known: thinkingSupport != null },
    { label: $t('localLoad.capVision'), on: Boolean(visionSelectedName), known: true },
    { label: $t('localLoad.capMtp'), on: mtp.builtIn, known: metadata?.has_mtp_layers != null || mtp.builtIn }
  ]);

  let projectorCandidates = $state<string[]>([]);

  $effect(() => {
    const modelPath = target?.path;
    if (!modelPath) {
      projectorCandidates = [];
      return;
    }
    void appStore.listProjectorCandidates(modelPath).then((list) => {
      // Offer a few one-click picks; "Choose file" covers the rest.
      projectorCandidates = [...new Set(list)].slice(0, 4);
    });
  });

  async function pickProjector() {
    if (!target?.path) return;
    const selected = await pickMmprojFile();
    if (selected) appStore.localModelLoadMmprojPath = selected;
  }

  // ── Command preview ──────────────────────────────────────────────────
  // Mirrors the config loadLocalModel() sends, so the preview is the truth.
  const previewConfig = $derived.by(() => ({
    model_path: target?.path || '',
    runtime_path: appStore.localModelLoadRuntimePath || undefined,
    backend_mode: 'auto',
    host: '127.0.0.1',
    port: 11435,
    context_length: contextIsAuto ? undefined : contextLength,
    gpu_offload: gpuLayersIsAuto ? undefined : gpuLayers,
    cpu_threads: Number(appStore.localModelLoadCpuThreads) || undefined,
    batch_size: Number(appStore.localModelLoadBatchSize) || undefined,
    flash_attention: appStore.localModelLoadFlashAttention,
    offload_kv_cache: appStore.localModelLoadOffloadKvCache,
    keep_in_memory: appStore.localModelLoadKeepInMemory,
    mmap: appStore.localModelLoadMmap,
    cache_type_k: appStore.localModelLoadCacheTypeK,
    cache_type_v: appStore.localModelLoadCacheTypeV,
    parallel: Number(appStore.localModelLoadParallel) > 1 ? Number(appStore.localModelLoadParallel) : undefined,
    mmproj_path: appStore.localModelLoadMmprojPath || undefined,
    thinking_mode: appStore.localModelLoadThinkingMode === 'auto'
      ? undefined
      : appStore.localModelLoadThinkingMode
  }));

  let commandPreview = $state('');
  let previewLoading = $state(false);
  let copiedPreview = $state(false);

  $effect(() => {
    if (!advancedOpen || !target?.path) return;
    const config = previewConfig;
    const timer = setTimeout(() => {
      previewLoading = true;
      void previewLocalModelCommand(config)
        .then((result) => { commandPreview = result.command; })
        .catch(() => { commandPreview = ''; })
        .finally(() => { previewLoading = false; });
    }, 350);
    return () => clearTimeout(timer);
  });

  async function copyCommandPreview() {
    if (!commandPreview) return;
    try {
      await navigator.clipboard.writeText(commandPreview);
      copiedPreview = true;
      setTimeout(() => (copiedPreview = false), 1600);
    } catch { /* clipboard unavailable */ }
  }

  function applyRecommendedPreset() {
    if (!recommended) return;
    // Applying the preset is an explicit choice: it takes both sliders off auto.
    localContextLength = Number(recommended.context_length || contextLength);
    localGpuLayers = Number(recommended.gpu_layers || 0);
    localCpuThreads = Number(recommended.cpu_threads || localCpuThreads);
    contextIsAuto = false;
    gpuLayersIsAuto = false;
    appStore.localModelLoadContextLength = String(localContextLength);
    appStore.localModelLoadGpuLayers = String(localGpuLayers);
    appStore.localModelLoadCpuThreads = String(localCpuThreads);
    appStore.localModelLoadBatchSize = String(recommended.batch_size || appStore.localModelLoadBatchSize || 512);
    appStore.localModelLoadFlashAttention = recommended.flash_attention ?? true;
    appStore.localModelLoadOffloadKvCache = recommended.offload_kv ?? true;
    appStore.localModelLoadMmap = recommended.use_mmap ?? true;
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
    localGpuLayers = storedGpu ? Number(storedGpu) : untrack(() => gpuLayersMax);
    localCpuThreads = Number(storedCpu || 4);
  });

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

  // Segmented choices. "custom" is whatever the slider says.
  const gpuChoice = $derived(gpuLayersIsAuto ? 'auto' : gpuLayers >= gpuLayersMax ? 'all' : gpuLayers === 0 ? 'cpu' : 'custom');
  function chooseGpu(value: string) {
    if (value === 'auto') {
      gpuLayersIsAuto = true;
      appStore.localModelLoadGpuLayers = '';
      return;
    }
    if (value === 'all') localGpuLayers = gpuLayersMax;
    else if (value === 'cpu') localGpuLayers = 0;
    else return;
    commitGpuLayers();
  }

  const contextChoice = $derived(contextIsAuto ? 'auto' : contextPresets.includes(contextLength) ? String(contextLength) : 'custom');
  function chooseContext(value: string) {
    if (value === 'auto') {
      contextIsAuto = true;
      appStore.localModelLoadContextLength = '';
      return;
    }
    if (value === 'custom') return;
    localContextLength = Number(value);
    commitContext();
  }
  const shortContext = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));

  $effect(() => {
    const model = target;
    if (!model?.path) return;
    loadingMeta = true;
    metadata = null;
    hardware = null;
    recommended = null;
    // Don't track the sliders — fetch once per model, not on every tick.
    const ctx = untrack(() => Number(appStore.localModelLoadContextLength || 0)) || undefined;
    const gpu = untrack(() => Number(appStore.localModelLoadGpuLayers || 0)) || undefined;
    void Promise.allSettled([
      getGgufMetadata(model.path),
      getHardwareLimits(),
      getRecommendedSettings(model.path, ctx, gpu, appStore.localModelLoadRuntimePath || appStore.config?.llm?.local?.runtime_path)
    ]).then(([metaResult, hardwareResult, recommendedResult]) => {
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

  function openRuntimeManager() {
    appStore.closeLocalModelLoadDialog();
    appStore.openSettings('runtime');
  }

  const loadBlockedReason = $derived(
    hasRuntime === false ? $t('localLoad.runtimeMissingShort') : !memoryEstimate.compatible ? $t('localLoad.fitWontFit') : ''
  );
</script>

{#snippet row(title: string, hint: string, control: import('svelte').Snippet, below?: import('svelte').Snippet)}
  <div class="load-row">
    <div class="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
      <span class="load-label">
        {title}
        {#if hint}
          <Tooltip label={hint} position="top">
            <button type="button" class="load-hint" aria-label={hint}><Info class="size-3" /></button>
          </Tooltip>
        {/if}
      </span>
      {@render control()}
    </div>
    {#if below}<div class="pb-1 pt-0.5">{@render below()}</div>{/if}
  </div>
{/snippet}

{#snippet field(label: string, control: import('svelte').Snippet)}
  <label class="block space-y-1.5">
    <span class="text-xs font-medium text-muted-foreground">{label}</span>
    {@render control()}
  </label>
{/snippet}

{#if target}
  <Dialog
    title={target.name}
    description={appStore.localModelLoadAsInstance ? $t('instances.startTitle') : $t('localLoad.title')}
    class="max-w-[60rem]"
    onclose={() => appStore.closeLocalModelLoadDialog()}
  >
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
      <!-- What this model is and what it can do -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        {#if headerMetaLine}<span class="text-xs text-muted-foreground">{headerMetaLine}</span>{/if}
        <div class="flex flex-wrap gap-1.5">
          {#each capabilities as cap (cap.label)}
            <Badge tone={cap.on ? 'success' : 'neutral'} title={cap.known ? '' : $t('localLoad.capUnknown')}>
              {cap.label}{cap.known ? '' : ' ?'}
            </Badge>
          {/each}
        </div>
        {#if loadingMeta}
          <LoaderCircle class="size-3.5 animate-spin text-muted-foreground" aria-label={$t('localLoad.readingModel')} />
        {/if}
      </div>
      {#if templateFallbackNote}
        <p class="mt-1.5 text-xs text-muted-foreground">{templateFallbackNote}</p>
      {/if}

      {#if hasRuntime === false}
        <div class="mt-4 flex items-start gap-3 rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5">
          <AlertTriangle class="mt-0.5 size-4 shrink-0 text-warning" />
          <div class="min-w-0 flex-1">
            <p class="text-[13px] font-medium text-foreground">{$t('localLoad.runtimeMissing')}</p>
            <p class="text-xs text-muted-foreground">{$t('localLoad.runtimeMissingHint')}</p>
          </div>
          <Button size="sm" onclick={openRuntimeManager}>{$t('localLoad.installRuntime')}</Button>
        </div>
      {/if}

      <!-- Will it fit? -->
      {#if fit}
        <div class="mt-3 rounded-xl bg-muted px-3.5 py-3">
          <div class="flex items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2 text-[13px] font-medium"
              class:text-success={fit.tone === 'success'}
              class:text-warning={fit.tone === 'warning'}
              class:text-error={fit.tone === 'error'}
            >
              {#if fit.tone === 'success'}<CircleCheck class="size-4 shrink-0" />
              {:else if fit.tone === 'neutral'}<Info class="size-4 shrink-0 text-muted-foreground" />
              {:else}<AlertTriangle class="size-4 shrink-0" />{/if}
              <span class="min-w-0">{fit.text}</span>
            </div>
            <button type="button" class="ui-chip" onclick={applyRecommendedPreset} disabled={!recommended}>
              <Sparkles /> {$t('localLoad.useRecommended')}
            </button>
          </div>
          <div class="mt-2.5 space-y-2">
            {#each meterRows as meter (meter.label)}
              {@const pct = meter.total > 0 ? Math.min(100, (meter.used / meter.total) * 100) : 0}
              <div class="grid grid-cols-[3rem_1fr_auto] items-center gap-3 text-xs text-muted-foreground">
                <span>{meter.label}</span>
                <div class="h-1 overflow-hidden rounded-full bg-[var(--surface-active)]">
                  <div class="h-full rounded-full transition-[width] {meter.used > meter.total * 0.95 ? 'bg-error' : 'bg-primary'}" style="width: {pct}%"></div>
                </div>
                <span class="tabular-nums">{meter.used.toFixed(1)} / {meter.total.toFixed(1)} GB</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- The few choices most people make -->
      <div class="mt-2">
        {#snippet gpuControl()}
          <SegmentedControl
            label={$t('localLoad.gpuLayers')}
            value={gpuChoice}
            onchange={chooseGpu}
            options={[
              { value: 'auto', label: $t('localLoad.auto') },
              { value: 'all', label: $t('localLoad.gpuAll', { values: { n: gpuLayersMax } }) },
              { value: 'cpu', label: $t('localLoad.gpuCpu') },
              ...(gpuChoice === 'custom' ? [{ value: 'custom', label: String(gpuLayers) }] : [])
            ]}
          />
        {/snippet}
        {#snippet gpuSlider()}
          <input
            type="range"
            min="0"
            max={gpuLayersMax}
            value={localGpuLayers}
            aria-label={$t('localLoad.gpuLayers')}
            oninput={(e) => { localGpuLayers = Number(e.currentTarget.value); }}
            onchange={commitGpuLayers}
            class="load-range w-full"
            class:is-auto={gpuLayersIsAuto}
          />
        {/snippet}
        {@render row($t('localLoad.gpuLayers'), $t('localLoad.gpuLayersHint'), gpuControl, gpuSlider)}

        {#snippet contextControl()}
          <SegmentedControl
            label={$t('localLoad.context')}
            value={contextChoice}
            onchange={chooseContext}
            options={[
              { value: 'auto', label: $t('localLoad.auto') },
              ...contextPresets.map((preset) => ({ value: String(preset), label: shortContext(preset) })),
              ...(contextChoice === 'custom' ? [{ value: 'custom', label: shortContext(contextLength) }] : [])
            ]}
          />
        {/snippet}
        {#snippet contextSlider()}
          <div class="flex items-center gap-3">
            <input
              type="range"
              min="512"
              max={maxContext}
              step="512"
              value={localContextLength}
              aria-label={$t('localLoad.context')}
              oninput={(e) => { localContextLength = Number(e.currentTarget.value); }}
              onchange={commitContext}
              class="load-range min-w-0 flex-1"
              class:is-auto={contextIsAuto}
            />
            <span class="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{contextIsAuto ? $t('localLoad.auto') : contextLength.toLocaleString()}</span>
          </div>
        {/snippet}
        {@render row($t('localLoad.context'), $t('localLoad.contextHint'), contextControl, contextSlider)}

        {#snippet thinkingControl()}
          <SegmentedControl
            label={$t('localLoad.thinking')}
            value={appStore.localModelLoadThinkingMode}
            onchange={(mode) => { appStore.localModelLoadThinkingMode = mode as 'auto' | 'off' | 'on'; }}
            options={[
              { value: 'auto', label: $t('localLoad.auto'), disabled: thinkingLocked },
              { value: 'off', label: $t('localLoad.off'), disabled: thinkingLocked },
              { value: 'on', label: $t('localLoad.on'), disabled: thinkingLocked }
            ]}
          />
        {/snippet}
        {@render row($t('localLoad.thinking'), thinkingLocked ? $t('localLoad.thinkingUnsupported') : $t('localLoad.thinkingHint'), thinkingControl)}

        {#snippet visionControl()}
          <div class="flex min-w-0 shrink-0 items-center gap-1.5">
            {#if visionSelectedName}
              <span class="max-w-[16rem] truncate font-mono text-[13px] text-muted-foreground" title={visionSelectedName}>{visionSelectedName}</span>
              <button type="button" class="ui-chip" onclick={() => { appStore.localModelLoadMmprojPath = ''; }}>{$t('localLoad.clear')}</button>
            {/if}
            <button type="button" class="ui-chip" onclick={pickProjector}>
              {visionSelectedName ? $t('localLoad.change') : $t('localLoad.chooseFile')}
            </button>
          </div>
        {/snippet}
        {#snippet visionCandidates()}
          <div class="flex flex-wrap gap-1.5">
            {#each projectorCandidates as candidate (candidate)}
              <button type="button" class="ui-chip font-mono" title={candidate} onclick={() => { appStore.localModelLoadMmprojPath = candidate; }}>
                {candidate.split(/[/\\]/).pop()}
              </button>
            {/each}
          </div>
        {/snippet}
        {@render row(
          $t('localLoad.vision'),
          $t('localLoad.visionHint'),
          visionControl,
          projectorCandidates.length && !visionSelectedName ? visionCandidates : undefined
        )}

        {#if isMoeModel}
          {#snippet moeControl()}
            <Switch label={$t('localLoad.moe')} bind:checked={appStore.localModelLoadCpuMoe} />
          {/snippet}
          {#snippet moeLayers()}
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{$t('localLoad.moeLayers')}</span>
              <input
                class="load-input w-20"
                type="number"
                min="0"
                max={blockCount || 999}
                bind:value={appStore.localModelLoadNCpuMoe}
                placeholder={$t('localLoad.all')}
                inputmode="numeric"
              />
            </div>
          {/snippet}
          {@render row(
            $t('localLoad.moe'),
            $t('localLoad.moeHint', { values: { n: expertCount } }),
            moeControl,
            appStore.localModelLoadCpuMoe ? moeLayers : undefined
          )}
        {/if}

        {#snippet mtpControl()}
          <Switch
            label={$t('localLoad.mtp')}
            bind:checked={appStore.localModelLoadMtpEnabled}
            disabled={!mtp.allowToggle}
          />
        {/snippet}
        {#snippet mtpDraft()}
          <div class="flex flex-wrap items-center gap-2">
            <input
              class="load-input min-w-0 flex-1"
              type="text"
              bind:value={appStore.localModelLoadMtpDraftPath}
              placeholder={$t('localLoad.mtpDraftPlaceholder')}
              aria-label={$t('localLoad.mtpDraft')}
            />
            <Select
              value={appStore.localModelLoadMtpDraftNMax}
              onchange={(value) => { appStore.localModelLoadMtpDraftNMax = value; }}
              options={[
                { value: '', label: 'n-max' },
                ...mtpDraftNMaxPresets.map((preset) => ({ value: String(preset), label: String(preset) }))
              ]}
              class="h-8 w-24 text-xs"
              aria-label={$t('localLoad.mtpDraftMax')}
            />
          </div>
        {/snippet}
        {@render row(
          $t('localLoad.mtp'),
          !mtp.allowToggle ? $t('localLoad.mtpUnsupported') : mtp.builtIn ? $t('localLoad.mtpBuiltIn') : $t('localLoad.mtpHint'),
          mtpControl,
          mtp.requireDraft && appStore.localModelLoadMtpEnabled ? mtpDraft : undefined
        )}
      </div>

      {#if appStore.localModelLoadAsInstance}
        <!-- Another instance: its own port, optionally reachable from the network. -->
        <label class="mt-3 flex items-start gap-3 rounded-xl bg-muted px-3.5 py-3">
          <Switch bind:checked={appStore.localModelLoadShare} label={$t('instances.shareOnNetwork')} />
          <span class="text-[13px] text-foreground">
            {$t('instances.shareOnNetwork')}
            <span class="block text-xs text-muted-foreground">{$t('instances.shareHintNew')}</span>
          </span>
        </label>
      {/if}

      <!-- Everything llama-server accepts, for people who know what they want -->
      <Disclosure quiet class="mt-2" title={$t('localLoad.advanced')} description={$t('localLoad.advancedHint')} bind:open={advancedOpen}>
        <div class="space-y-4">
          {#if hardware}
            <p class="text-xs text-muted-foreground">
              {hardware.gpu_name || $t('localLoad.cpuOnly')}{hardware.vram_gb > 0 ? ` · ${hardware.vram_estimated ? '~' : ''}${hardware.vram_gb.toFixed(1)} GB VRAM` : ''}
              · {hardware.physical_cores}C / {hardware.cpu_threads}T · {hardware.total_ram_gb.toFixed(0)} GB RAM
              {#if recommended?.backend} · {recommended.backend}{/if}
            </p>
          {/if}

          <div class="grid gap-3 sm:grid-cols-2">
            {#snippet threads()}
              <div class="flex items-center gap-3">
                <input type="range" min="1" max={cpuThreadsMax} bind:value={localCpuThreads} onchange={commitCpuThreads} class="load-range flex-1" />
                <span class="w-8 text-right text-xs tabular-nums text-muted-foreground">{localCpuThreads}</span>
              </div>
            {/snippet}
            {@render field($t('localLoad.cpuThreads'), threads)}
            {#snippet batch()}<input class="load-input w-full" bind:value={appStore.localModelLoadBatchSize} inputmode="numeric" />{/snippet}
            {@render field($t('localLoad.batchSize'), batch)}
            {#snippet cacheK()}<Select class="h-9 w-full text-[13px]" bind:value={appStore.localModelLoadCacheTypeK} options={cacheTypes.map((type) => ({ value: type, label: type }))} />{/snippet}
            {@render field($t('localLoad.cacheTypeK'), cacheK)}
            {#snippet cacheV()}<Select class="h-9 w-full text-[13px]" bind:value={appStore.localModelLoadCacheTypeV} options={cacheTypes.map((type) => ({ value: type, label: type }))} />{/snippet}
            {@render field($t('localLoad.cacheTypeV'), cacheV)}
            {#snippet parallel()}<input class="load-input w-full" bind:value={appStore.localModelLoadParallel} inputmode="numeric" />{/snippet}
            {@render field($t('localLoad.parallel'), parallel)}
            {#snippet split()}<Select class="h-9 w-full text-[13px]" bind:value={appStore.localModelLoadSplitMode} options={splitModes.map((mode) => ({ value: mode, label: mode || $t('localLoad.auto') }))} />{/snippet}
            {@render field($t('localLoad.splitMode'), split)}
            {#snippet seed()}<input class="load-input w-full" bind:value={appStore.localModelLoadSeed} inputmode="numeric" placeholder={$t('localLoad.optional')} />{/snippet}
            {@render field($t('localLoad.seed'), seed)}
            {#snippet cacheRam()}<input class="load-input w-full" bind:value={appStore.localModelLoadCacheRamMb} inputmode="numeric" placeholder="8192" />{/snippet}
            {@render field($t('localLoad.promptCache'), cacheRam)}
            {#snippet ropeBase()}<input class="load-input w-full" bind:value={appStore.localModelLoadRopeFreqBase} inputmode="decimal" placeholder={$t('localLoad.optional')} />{/snippet}
            {@render field($t('localLoad.ropeBase'), ropeBase)}
            {#snippet ropeScale()}<input class="load-input w-full" bind:value={appStore.localModelLoadRopeFreqScale} inputmode="decimal" placeholder={$t('localLoad.optional')} />{/snippet}
            {@render field($t('localLoad.ropeScale'), ropeScale)}
            {#snippet cacheReuse()}<input class="load-input w-full" bind:value={appStore.localModelLoadCacheReuse} inputmode="numeric" placeholder="0" />{/snippet}
            {@render field($t('localLoad.cacheReuse'), cacheReuse)}
            {#snippet runtimePath()}<input class="load-input w-full" bind:value={appStore.localModelLoadRuntimePath} placeholder={$t('localLoad.runtimePathPlaceholder')} />{/snippet}
            {@render field($t('localLoad.runtimePath'), runtimePath)}
          </div>

          <div class="grid gap-x-6 sm:grid-cols-2">
            {#each engineToggles as [key, prop] (key)}
              <div class="flex items-center justify-between gap-3 py-1.5 text-[13px]">
                <span title={$t(`localLoad.${key}Hint`)}>{$t(`localLoad.${key}`)}</span>
                <Switch label={$t(`localLoad.${key}`)} bind:checked={appStore[prop]} />
              </div>
            {/each}
          </div>

          <!-- Command preview: exactly what llama-server will be told, built
               through the same resolver as a real launch. -->
          <div class="rounded-lg bg-muted/50 p-3">
            <div class="flex items-center justify-between gap-2 pb-2">
              <span class="text-xs font-medium text-muted-foreground">{$t('localLoad.command')}</span>
              {#if commandPreview}
                <Button variant="ghost" size="xs" onclick={copyCommandPreview}>
                  {copiedPreview ? $t('localLoad.copied') : $t('localLoad.copy')}
                </Button>
              {/if}
            </div>
            {#if previewLoading && !commandPreview}
              <p class="text-xs text-muted-foreground">{$t('localLoad.commandResolving')}</p>
            {:else if commandPreview}
              <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-muted-foreground">{commandPreview}</pre>
              <p class="pt-1.5 text-[12px] text-muted-foreground">{$t('localLoad.commandNote')}</p>
            {:else}
              <p class="text-xs text-muted-foreground">{$t('localLoad.commandUnavailable')}</p>
            {/if}
          </div>
        </div>
      </Disclosure>

      {#if appStore.localModelLoadError && !loading}
        <div class="mt-3 flex items-start gap-2 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-xs text-error" role="alert">
          <AlertTriangle class="mt-0.5 size-3.5 shrink-0" />
          <span class="min-w-0 break-words">{appStore.localModelLoadError}</span>
        </div>
      {/if}
    </div>

    {#snippet footer()}
      {#if loading}
        <div class="mr-auto flex min-w-0 flex-1 items-center gap-3">
          <LoaderCircle class="size-4 shrink-0 animate-spin text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <div class="h-1.5 overflow-hidden rounded-full bg-muted">
              <div class="h-full rounded-full bg-primary transition-[width]" style="width: {Math.max(6, appStore.localModelLoadProgress)}%"></div>
            </div>
            <div class="mt-1 truncate text-xs text-muted-foreground">{appStore.localModelLoadPhase || $t('localLoad.loading')}</div>
          </div>
        </div>
        <Button variant="outline" onclick={() => appStore.closeLocalModelLoadDialog()}>{$t('localLoad.hide')}</Button>
        <Button variant="destructive" onclick={() => appStore.stopLocalModel()}>{$t('localLoad.stop')}</Button>
      {:else}
        <div class="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Switch label={$t('localLoad.remember')} bind:checked={appStore.localModelRememberSettings} />
          <span>{$t('localLoad.remember')}</span>
          {#if isAnyModelLoaded}
            <Button variant="ghost" size="sm" class="ml-2" onclick={async () => { await appStore.stopLocalModel(); appStore.closeLocalModelLoadDialog(); }}>
              {$t('localLoad.unloadCurrent')}
            </Button>
          {/if}
        </div>
        {#if loadBlockedReason}
          <span class="text-xs text-error">{loadBlockedReason}</span>
        {/if}
        <Button variant="ghost" onclick={() => appStore.closeLocalModelLoadDialog()}>{$t('localLoad.cancel')}</Button>
        <Button onclick={() => appStore.confirmLocalModelLoad()} disabled={Boolean(loadBlockedReason)}>{appStore.localModelLoadAsInstance ? $t('instances.start') : $t('localLoad.load')}</Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .load-range {
    height: 0.25rem;
    cursor: pointer;
    accent-color: var(--primary);
  }
  .load-range.is-auto {
    opacity: 0.4;
  }
  .load-row + .load-row {
    margin-top: 0.125rem;
  }
  .load-label {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--foreground);
  }
  .load-hint {
    display: inline-flex;
    padding: 0.125rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    cursor: help;
    outline: none;
  }
  .load-hint:hover,
  .load-hint:focus-visible {
    color: var(--foreground);
  }
  .load-input {
    height: 2.25rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--background);
    padding: 0 0.625rem;
    font-size: 13px;
    color: var(--text);
    outline: none;
  }
  .load-input:focus {
    border-color: var(--border-hover);
  }
</style>
