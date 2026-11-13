<svelte:options runes={true} />

<script lang="ts">
  import { writeToClipboard } from '$lib/utils/clipboard';
  import DialogActions from '$lib/components/ui/DialogActions.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import UiRange from '$lib/components/ui/Range.svelte';
  import LoadSizeControl from './LoadSizeControl.svelte';
  import { shortTokens } from './load-sizing';
  import { DEFAULT_LOCAL_PARALLEL } from '$lib/stores/app-store-local-model';
  import { cn as uiClass } from '$lib/utils/cn';

  import type { GgufMeta, HardwareInfo, RecommendedSettings } from '$lib/types/bridge';
  import { AlertTriangle, CircleCheck, Info, LoaderCircle, Sparkles } from '$lib/icons';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { getHardwareLimits } from '$lib/services/hardware';
  import { getGgufMetadata } from '$lib/services/models';
  import { getRecommendedSettings, getRuntimeDevices, previewLocalModelCommand, type RuntimeDevice } from '$lib/services/runtime';
  import { getInstalledRuntimes, pickMmprojFile } from '$lib/services/files';
  import { formatContextLength, formatModelParameterCount } from '$lib/utils/local-models';
  import { formatBytes } from '$lib/utils/format';
  import { shortModelName } from '$lib/features/chat/model-menu/model-menu';
  import { localWithLoadState } from '$lib/stores/app-store-local-model';
  import { launchConfigFromSaved } from '$shared/local-launch';
  import { Badge, Button, Dialog, Disclosure, Input, SegmentedControl, Select, Switch } from '$lib/components/ui';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';

  const cacheTypes = ['f16', 'q8_0', 'q4_0'];
  /** '' leaves the cache type to the server (q8_0 K on a GPU, f16 otherwise). */
  const cacheOptions = $derived([{ value: '', label: $t('localLoad.auto') }, ...cacheTypes.map((type) => ({ value: type, label: type }))]);
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
  const slotChoices = [1, 2, 4, 8];
  /** What --fit may shrink an auto context to (main/process-manager.ts MIN_AUTO_CONTEXT). */
  const AUTO_CONTEXT_FLOOR = 16384;

  let metadata = $state<GgufMeta | null>(null);
  let hardware = $state<HardwareInfo | null>(null);
  let recommended = $state<RecommendedSettings | null>(null);
  let advancedOpen = $state(false);
  let loadingMeta = $state(false);

  const target = $derived(appStore.localModelLoadTarget);
  const loading = $derived(appStore.localModelLoading);
  const isAnyModelLoaded = $derived(Boolean(modelsStore.status?.active_model));
  /** The model this dialog would load is the one already running: Load reloads it. */
  const isReload = $derived(!appStore.localModelLoadAsInstance && !!target?.path
    && String(appStore.localModelActive?.path || '').toLowerCase() === target.path.toLowerCase());
  /**
   * RAM the running model gives back when this load replaces it. "Free RAM"
   * counts it as used, so reloading the same model always read as "tight".
   */
  const releasedGb = $derived.by(() => {
    if (appStore.localModelLoadAsInstance || !appStore.localModelActive?.path) return 0;
    const reported = Number(modelsStore.status?.memory_mb) || 0;
    if (reported > 0) return reported / 1024;
    const running = modelsStore.availableModels?.find((model) => String(model.path || '').toLowerCase() === String(appStore.localModelActive?.path).toLowerCase());
    return Number(running?.size_gb || 0) * 1.1;
  });
  /** Loading here swaps the one on-device model every chat shares: say which. */
  const replacing = $derived.by(() => {
    const active = appStore.localModelActive;
    if (appStore.localModelLoadAsInstance || !active?.path || !target?.path) return '';
    if (active.path.toLowerCase() === target.path.toLowerCase()) return '';
    return shortModelName(active.name || active.path);
  });
  const busyChats = $derived(appStore.chats.filter((chat) => appStore.isChatGenerating(chat.id) && appStore.configForChat(chat).llm?.backend_mode === 'local').length);
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

  // One source of truth: the store's load fields, where '' means auto (the flag
  // is left off and llama.cpp's --fit sizes it). The dialog used to keep its
  // own copies plus *IsAuto flags and an effect syncing them back, which is how
  // a value could read one thing and load another.
  const contextIsAuto = $derived(!appStore.localModelLoadContextLength);
  const gpuLayersIsAuto = $derived(!appStore.localModelLoadGpuLayers);
  const contextLength = $derived(Math.max(512, Math.min(maxContext, Number(appStore.localModelLoadContextLength) || maxContext)));
  const gpuLayers = $derived(Math.max(0, Math.min(gpuLayersMax, Number(appStore.localModelLoadGpuLayers) || 0)));

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
    // Only attention layers hold KV; on hybrid models that is a handful of them.
    const kvLayers = Math.max(1, Number(metadata?.kv_layer_count) || effectiveLayers);
    const fileSizeGb = fileSizeBytes / (1024 ** 3);
    // On auto, llama.cpp fits the context to memory, so estimate its floor.
    const estimatedContext = contextIsAuto ? Math.min(maxContext, AUTO_CONTEXT_FLOOR) : contextLength;
    const kvCacheBytes = 2 * headCountKv * headDim * estimatedContext * 2 * kvLayers;
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
    const vram = gpuMemoryGb;
    if (!memoryEstimate.compatible) return { tone: 'error', text: $t('localLoad.fitWontFit') };
    if (gpuLayersIsAuto) return { tone: 'neutral', text: $t('localLoad.fitAuto') };
    if (vram > 0 && memoryEstimate.gpuGb > vram * 0.95) return { tone: 'warning', text: $t('localLoad.fitOverVram') };
    if (memoryEstimate.ramNeededGb > (Number(hardware.free_ram_gb || 0) + releasedGb) * 0.9) return { tone: 'warning', text: $t('localLoad.fitTight') };
    if (gpuLayers === 0 || vram <= 0) return { tone: 'neutral', text: $t('localLoad.fitCpu') };
    if (gpuLayers < gpuLayersMax) return { tone: 'neutral', text: $t('localLoad.fitPartial') };
    return { tone: 'success', text: $t('localLoad.fitGpu') };
  });

  const meterRows = $derived.by(() => {
    if (!hardware) return [];
    const rows: Array<{ label: string; used: number; total: number }> = [];
    const vram = gpuMemoryGb;
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
  // Exactly what Load would launch: the values saved as Load would save them,
  // through the one launch mapping (shared/local-launch.ts).
  const previewConfig = $derived.by(() => {
    const path = target?.path || '';
    const local = localWithLoadState(appStore.config.llm?.local, path, appStore.localModelLoadState);
    return launchConfigFromSaved({ ...local, selected_model_path: path }, path);
  });

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
      if (!await writeToClipboard(commandPreview)) return;
      copiedPreview = true;
      setTimeout(() => (copiedPreview = false), 1600);
    } catch { /* clipboard unavailable */ }
  }

  function applyRecommendedPreset() {
    if (!recommended) return;
    // Applying the preset is an explicit choice: it takes both sliders off auto.
    setContext(Number(recommended.context_length) || contextLength);
    setGpuLayers(noGpu ? 0 : Number(recommended.gpu_layers || 0));
    if (recommended.cpu_threads) appStore.localModelLoadCpuThreads = String(recommended.cpu_threads);
    if (recommended.batch_size) appStore.localModelLoadBatchSize = String(recommended.batch_size);
    appStore.localModelLoadFlashAttention = recommended.flash_attention ?? true;
    appStore.localModelLoadOffloadKvCache = recommended.offload_kv ?? true;
    appStore.localModelLoadMmap = recommended.use_mmap ?? true;
  }

  function setContext(next: number | null) {
    appStore.localModelLoadContextLength = next === null ? '' : String(Math.max(512, Math.min(maxContext, next)));
  }
  function setGpuLayers(next: number | null) {
    appStore.localModelLoadGpuLayers = next === null ? '' : String(Math.max(0, Math.min(gpuLayersMax, next)));
  }

  /**
   * Switching to an engine that can offload starts GPU layers on auto: a 0
   * saved while the engine was CPU-only described that engine, not a choice.
   */
  function useEngine(path: string) {
    appStore.localModelLoadRuntimePath = path;
    setGpuLayers(null);
  }

  /** No GPU to offload to: the layer control would only pretend. */
  // ── Where layers can go: llama.cpp's --list-devices, not our hardware probe
  // (which reports no GPU for integrated Radeon/Intel graphics). A CPU-only
  // build lists nothing even on a machine with a GPU, so another installed
  // build that does is offered instead.
  let devices = $state<RuntimeDevice[] | null>(null);
  let gpuEngine = $state<{ path: string; name: string; device: string } | null>(null);
  const engineInUse = $derived(appStore.localModelLoadRuntimePath || appStore.config?.llm?.local?.runtime_path || '');
  $effect(() => {
    const path = engineInUse;
    if (!target) return;
    devices = null;
    gpuEngine = null;
    let cancelled = false;
    void (async () => {
      const found = await getRuntimeDevices(path).catch(() => ({ runtimePath: null, devices: [] as RuntimeDevice[] }));
      if (cancelled) return;
      devices = found.devices;
      if (found.devices.length) return;
      const installed = await getInstalledRuntimes().catch(() => ({ runtimes: [] as Array<{ path: string; name: string }> }));
      for (const engine of installed.runtimes ?? []) {
        if (!engine.path || engine.path === found.runtimePath) continue;
        const other = await getRuntimeDevices(engine.path).catch(() => null);
        if (cancelled) return;
        if (other?.devices.length) {
          gpuEngine = { path: engine.path, name: engine.name, device: other.devices[0].name };
          return;
        }
      }
    })();
    return () => { cancelled = true; };
  });
  const gpuDevice = $derived(devices?.[0] ?? null);
  const noGpu = $derived(devices !== null && devices.length === 0);
  /** Memory the offload target has: a discrete card's VRAM, or what llama.cpp says the device has free. */
  const gpuMemoryGb = $derived(Number(hardware?.vram_gb) > 0 ? Number(hardware?.vram_gb) : gpuDevice?.freeMb ? gpuDevice.freeMb / 1024 : 0);
  const gpuHint = $derived(gpuDevice
    ? `${gpuDevice.name}${gpuDevice.freeMb ? ` · ${(gpuDevice.freeMb / 1024).toFixed(1)} GB ${$t('localLoad.free')}` : ''}`
    : '');
  const slots = $derived(Math.max(1, Number(appStore.localModelLoadParallel) || DEFAULT_LOCAL_PARALLEL));

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

  // Only a missing runtime blocks Load. The memory figure is our estimate, and
  // llama.cpp reports a real failure in this dialog, so a "won't fit" stays a
  // warning (as in LM Studio) instead of a disabled button.
  const loadBlockedReason = $derived(hasRuntime === false ? $t('localLoad.runtimeMissingShort') : '');
</script>

{#snippet row(title: string, hint: string, control: import('svelte').Snippet, below?: import('svelte').Snippet)}
  <div class="load-row">
    <span class="load-text">
      <span class="load-label">{title}</span>
      {#if hint}<span class="load-caption">{hint}</span>{/if}
    </span>
    <span class="load-control">{@render control()}</span>
    {#if below}<div class="load-below">{@render below()}</div>{/if}
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
    title={shortModelName(target.name)}
    description={appStore.localModelLoadAsInstance ? $t('instances.startTitle') : $t('localLoad.title')}
    class="max-w-[46rem]"
    onclose={() => appStore.closeLocalModelLoadDialog()}
  >
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
      <!-- What this model is and what it can do -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        {#if headerMetaLine}<span class="text-xs text-muted-foreground">{headerMetaLine}</span>{/if}
        <div class="flex flex-wrap gap-1.5">
          {#each capabilities.filter((cap) => cap.on) as cap (cap.label)}
            <Badge tone="neutral">{cap.label}</Badge>
          {/each}
        </div>
        {#if loadingMeta}
          <LoaderCircle class="size-3.5 animate-spin text-muted-foreground" aria-label={$t('localLoad.readingModel')} />
        {/if}
      </div>
      {#if replacing && !loading}
        <p class="mt-1.5 text-xs text-muted-foreground">
          {$t('localLoad.replaces', { values: { current: replacing } })}{#if busyChats} · {$t('modelPicker.switchBusy', { values: { n: busyChats } })}{/if}
        </p>
      {/if}
      {#if templateFallbackNote}
        <p class="mt-1.5 text-xs text-muted-foreground">{templateFallbackNote}</p>
      {/if}

      {#if hasRuntime === false}
        <div class="mt-4 flex items-start gap-3 rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5">
          <AlertTriangle class="mt-0.5 size-4 shrink-0 text-warning" />
          <div class="min-w-0 flex-1">
            <p class="text-[length:var(--text-sm)] font-medium text-foreground">{$t('localLoad.runtimeMissing')}</p>
            <p class="text-xs text-muted-foreground">{$t('localLoad.runtimeMissingHint')}</p>
          </div>
          <Button size="sm" onclick={openRuntimeManager}>{$t('localLoad.installRuntime')}</Button>
        </div>
      {/if}

      <!-- Will it fit? One row in the same grid as the settings. -->
      {#if fit}
        <div class="load-row load-memory">
          <span class="load-text">
            <span class="load-label">{$t('localLoad.memory')}</span>
            <span class="load-caption" class:text-warning={fit.tone === 'warning'} class:text-error={fit.tone === 'error'}>{fit.text}</span>
          </span>
          <span class="memory-meters">
            {#each meterRows as meter (meter.label)}
              {@const pct = meter.total > 0 ? Math.min(100, (meter.used / meter.total) * 100) : 0}
              <span class="memory-meter">
                <span class="memory-name">{meter.label}</span>
                <span class="memory-track"><span class="memory-fill" class:is-over={meter.used > meter.total * 0.95} style="width: {pct}%"></span></span>
                <span class="memory-value">{meter.used.toFixed(1)} / {meter.total.toFixed(1)} GB</span>
              </span>
            {/each}
          </span>
        </div>
      {/if}

      <!-- Resources: what the load costs -->
      <div class="load-group">
        <LoadSizeControl
          kind="context"
          label={$t('localLoad.context')}
          hint={contextIsAuto
            ? $t('localLoad.contextAuto', { values: { min: shortTokens(Math.min(maxContext, AUTO_CONTEXT_FLOOR)) } })
            : $t('localLoad.contextPerChat', { values: { max: shortTokens(maxContext) } })}
          value={contextIsAuto ? maxContext : contextLength}
          auto={contextIsAuto}
          leaveAuto={Math.min(maxContext, 32768)}
          min={512}
          max={maxContext}
          onchange={setContext}
        />

        {#snippet slotsControl()}
          <SegmentedControl
            label={$t('computer.server.parallel')}
            value={String(slots)}
            onchange={(value) => { appStore.localModelLoadParallel = value; }}
            options={[...new Set([...slotChoices, slots])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: String(n) }))}
          />
        {/snippet}
        {@render row($t('computer.server.parallel'), $t('localLoad.slotsHint'), slotsControl)}

        {#if noGpu}
          {#snippet cpuOnly()}
            <span class="flex items-center gap-2">
              <span class="text-[length:var(--text-sm)] text-muted-foreground">{gpuEngine ? $t('localLoad.engineCpuOnly') : $t('localLoad.noGpu')}</span>
              {#if gpuEngine}
                {@const engine = gpuEngine}
                <Button variant="outline" size="xs" title={engine.name} onclick={() => useEngine(engine.path)}>
                  {$t('localLoad.useGpuEngine', { values: { device: engine.device } })}
                </Button>
              {/if}
            </span>
          {/snippet}
          {@render row($t('localLoad.gpuLayers'), '', cpuOnly)}
        {:else}
          <LoadSizeControl
            kind="layers"
            label={$t('localLoad.gpuLayers')}
            hint={[gpuHint, gpuLayersIsAuto ? $t('localLoad.gpuAuto') : ''].filter(Boolean).join(' · ') || $t('localLoad.gpuLayersHint')}
            value={gpuLayersIsAuto ? gpuLayersMax : gpuLayers}
            auto={gpuLayersIsAuto}
            leaveAuto={gpuLayersMax}
            min={0}
            max={gpuLayersMax}
            onchange={setGpuLayers}
          />
        {/if}

      </div>

      <!-- Behaviour: what the model does once loaded -->
      <div class="load-group">
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
              <span class="max-w-[16rem] truncate font-mono text-[length:var(--text-sm)] text-muted-foreground" title={visionSelectedName}>{visionSelectedName}</span>
              <Button variant="ghost" size="xs" onclick={() => { appStore.localModelLoadMmprojPath = ''; }}>{$t('localLoad.clear')}</Button>
            {/if}
            <Button variant="outline" size="xs" onclick={pickProjector}>
              {visionSelectedName ? $t('localLoad.change') : $t('localLoad.chooseFile')}
            </Button>
          </div>
        {/snippet}
        {#snippet visionCandidates()}
          <div class="flex flex-wrap gap-1.5">
            {#each projectorCandidates as candidate (candidate)}
              <Button variant="outline" size="xs" class="font-mono" title={candidate} onclick={() => { appStore.localModelLoadMmprojPath = candidate; }}>
                {candidate.split(/[/\\]/).pop()}
              </Button>
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
              <Input
                class={uiClass("load-input w-20", "ui-local-a6eab888")}
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
            <Input
              class={uiClass("load-input min-w-0 flex-1", "ui-local-a6eab888")}
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
          <span class="text-[length:var(--text-sm)] text-foreground">
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
            <!-- Blank is auto: llama.cpp picks threads and batch for the machine. -->
            {#snippet threads()}<Input class="w-full" bind:value={appStore.localModelLoadCpuThreads} inputmode="numeric" placeholder={`${$t('localLoad.auto')} · 1–${cpuThreadsMax}`} />{/snippet}
            {@render field($t('localLoad.cpuThreads'), threads)}
            {#snippet batch()}<Input class="w-full" bind:value={appStore.localModelLoadBatchSize} inputmode="numeric" placeholder={$t('localLoad.auto')} />{/snippet}
            {@render field($t('localLoad.batchSize'), batch)}
            {#snippet cacheK()}<Select class="h-9 w-full text-[length:var(--text-sm)]" bind:value={appStore.localModelLoadCacheTypeK} options={cacheOptions} />{/snippet}
            {@render field($t('localLoad.cacheTypeK'), cacheK)}
            {#snippet cacheV()}<Select class="h-9 w-full text-[length:var(--text-sm)]" bind:value={appStore.localModelLoadCacheTypeV} options={cacheOptions} />{/snippet}
            {@render field($t('localLoad.cacheTypeV'), cacheV)}
            {#snippet split()}<Select class="h-9 w-full text-[length:var(--text-sm)]" bind:value={appStore.localModelLoadSplitMode} options={splitModes.map((mode) => ({ value: mode, label: mode || $t('localLoad.auto') }))} />{/snippet}
            {@render field($t('localLoad.splitMode'), split)}
            {#snippet seed()}<Input class="w-full" bind:value={appStore.localModelLoadSeed} inputmode="numeric" placeholder={$t('localLoad.optional')} />{/snippet}
            {@render field($t('localLoad.seed'), seed)}
            {#snippet cacheRam()}<Input class="w-full" bind:value={appStore.localModelLoadCacheRamMb} inputmode="numeric" placeholder="8192" />{/snippet}
            {@render field($t('localLoad.promptCache'), cacheRam)}
            {#snippet ropeBase()}<Input class="w-full" bind:value={appStore.localModelLoadRopeFreqBase} inputmode="decimal" placeholder={$t('localLoad.optional')} />{/snippet}
            {@render field($t('localLoad.ropeBase'), ropeBase)}
            {#snippet ropeScale()}<Input class="w-full" bind:value={appStore.localModelLoadRopeFreqScale} inputmode="decimal" placeholder={$t('localLoad.optional')} />{/snippet}
            {@render field($t('localLoad.ropeScale'), ropeScale)}
            {#snippet cacheReuse()}<Input class="w-full" bind:value={appStore.localModelLoadCacheReuse} inputmode="numeric" placeholder="0" />{/snippet}
            {@render field($t('localLoad.cacheReuse'), cacheReuse)}
            {#snippet runtimePath()}<Input class="w-full" bind:value={appStore.localModelLoadRuntimePath} placeholder={$t('localLoad.runtimePathPlaceholder')} />{/snippet}
            {@render field($t('localLoad.runtimePath'), runtimePath)}
          </div>

          <div class="grid gap-x-6 sm:grid-cols-2">
            {#each engineToggles as [key, prop] (key)}
              <div class="flex items-center justify-between gap-3 py-1.5 text-[length:var(--text-sm)]">
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
              <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[length:var(--text-xs)] leading-relaxed text-muted-foreground">{commandPreview}</pre>
              <p class="pt-1.5 text-[length:var(--text-xs)] text-muted-foreground">{$t('localLoad.commandNote')}</p>
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
        <DialogActions cancelLabel={$t('localLoad.hide')} confirmLabel={$t('localLoad.stop')} danger oncancel={() => appStore.closeLocalModelLoadDialog()} onconfirm={() => appStore.stopLocalModel()} />
      {:else}
        <div class="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
          {#if recommended}
            <Button variant="ghost" size="sm" onclick={applyRecommendedPreset}><Sparkles /> {$t('localLoad.useRecommended')}</Button>
          {/if}
          {#if isAnyModelLoaded}
            <Button variant="ghost" size="sm" class="ml-2" onclick={async () => { await appStore.stopLocalModel(); appStore.closeLocalModelLoadDialog(); }}>
              {$t('localLoad.unloadCurrent')}
            </Button>
          {/if}
        </div>
        {#if loadBlockedReason}
          <span class="text-xs text-error">{loadBlockedReason}</span>
        {/if}
        <DialogActions cancelLabel={$t('localLoad.cancel')} confirmLabel={appStore.localModelLoadAsInstance ? $t('instances.start') : isReload ? $t('localLoad.reload') : $t('localLoad.load')} disabled={Boolean(loadBlockedReason)} oncancel={() => appStore.closeLocalModelLoadDialog()} onconfirm={() => appStore.confirmLocalModelLoad()} />
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  :global(.load-range.ui-local-a6eab888) {
    height: 0.25rem;
    cursor: pointer;
    accent-color: var(--primary);
  }
  :global(.load-range.is-auto.ui-local-a6eab888) {
    opacity: 0.4;
  }
  /* One grid for every setting, as in LM Studio: what it is on the left,
     the control on the right edge, captions under the label. */
  .load-row {
    display: grid;
    grid-template-columns: minmax(10rem, 15rem) minmax(0, 1fr);
    align-items: center;
    gap: 0.25rem 1.5rem;
    min-height: 3rem;
    padding: 0.5rem 0;
  }
  .load-text { display: flex; min-width: 0; flex-direction: column; gap: 0.125rem; }
  .load-label {
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .load-caption { color: var(--muted-foreground); font-size: var(--text-xs); line-height: 1.4; }
  .load-control { display: flex; min-width: 0; justify-content: flex-end; }
  .load-below { grid-column: 2; display: flex; justify-content: flex-end; }
  .load-group { padding: 0.25rem 0; }
  .load-group + .load-group { border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
  .load-memory { margin-top: 0.5rem; }
  .memory-meters { display: flex; min-width: 0; flex-direction: column; gap: 0.375rem; }
  .memory-meter {
    display: grid;
    grid-template-columns: 2.5rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .memory-track { height: 0.25rem; overflow: hidden; border-radius: var(--radius-full); background: var(--muted); }
  .memory-fill { display: block; height: 100%; border-radius: inherit; background: var(--muted-foreground); transition: width var(--motion-fast) var(--motion-ease); }
  .memory-fill.is-over { background: var(--error); }
  .memory-value { font-variant-numeric: tabular-nums; }
  :global(.load-hint.ui-local-a6eab888) {
    display: inline-flex;
    padding: 0.125rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    cursor: help;
    outline: none;
  }
  :global(.load-hint:hover.ui-local-a6eab888),
  :global(.load-hint:focus-visible.ui-local-a6eab888) {
    color: var(--foreground);
  }
  :global(.load-input.ui-local-a6eab888) {
    height: 2.25rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--background);
    padding: 0 0.625rem;
    font-size: var(--text-sm);
    color: var(--text);
    outline: none;
  }
  :global(.load-input:focus.ui-local-a6eab888) {
    border-color: var(--border-hover);
  }
</style>
