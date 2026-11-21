import type { AppConfig, LocalThinkingMode, ModelOption } from '$lib/types/chat';
import type { LocalModelLoadTarget } from '$lib/stores/app-store-types';
import {
  DEFAULT_LOCAL_PARALLEL,
  localWithLoadState,
  resolveLocalModelLoadState,
  type LocalModelLoadState
} from '$lib/stores/app-store-local-model';
import { activeLoadConfig } from '$shared/local-launch';
import { invoke, isElectron } from '$lib/services/bridge';
import { detectToolSupport, loadChatConfig } from '$lib/services/chat-api';
import { listMmprojCandidates } from '$lib/services/files';
import { loadLocalModel, onSupervisorEvent } from '$lib/services/runtime';
import { modelsStore } from '$lib/stores/models.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { toErrorMessage } from '$lib/utils/errors';
import { describeLocalLoadError } from '$lib/utils/local-load-errors';

export interface LocalModelsHost {
  getConfig: () => AppConfig;
  commitConfig: (next: AppConfig) => Promise<void>;
  setBackendMode: (mode: 'local' | 'api') => Promise<void>;
  updateLocalModel: (model: ModelOption) => Promise<void>;
  refreshReasoningCapabilities: (force?: boolean) => Promise<void>;
}

/**
 * Local-model load dialog state, runtime status mirroring, and single-IPC
 * projector lookup. Delegated from `AppStore` so its public API stays intact
 * while keeping `app.svelte.ts` focused on session orchestration.
 */
export class LocalModelsController {
  loadTarget = $state<LocalModelLoadTarget | null>(null);
  /** The load dialog starts another instance (Models → Running) instead of replacing the chat model. */
  loadAsInstance = $state(false);
  /** Instance mode: bind to the local network. */
  loadShare = $state(false);
  // Empty means auto: llama.cpp's --fit sizes these against real device memory.
  loadContextLength = $state('');
  loadGpuLayers = $state('');
  loadCpuThreads = $state('4');
  loadBatchSize = $state('512');
  loadRuntimePath = $state('');
  loadFlashAttention = $state(true);
  loadOffloadKvCache = $state(true);
  loadKeepInMemory = $state(false);
  loadMmap = $state(true);
  loadSeed = $state('');
  loadParallel = $state(String(DEFAULT_LOCAL_PARALLEL));
  /** Guards against an older open finishing after a newer one. */
  private loadOpenToken = 0;
  loadRopeFreqBase = $state('');
  loadRopeFreqScale = $state('');
  loadCacheTypeK = $state('f16');
  loadCacheTypeV = $state('f16');
  loadMmprojPath = $state('');
  /** Thinking default for this load: 'auto' omits --reasoning (server detects). */
  loadThinkingMode = $state<LocalThinkingMode>('auto');
  loadMtpEnabled = $state(false);
  loadMtpDraftPath = $state('');
  loadMtpDraftNMax = $state('');
  loadCpuMoe = $state(false);
  loadNCpuMoe = $state('');
  loadContextShift = $state(false);
  loadCacheRamMb = $state('');
  loadCacheReuse = $state('');
  loadSwaFull = $state(false);
  loadSplitMode = $state('');
  loadProgress = $state(0);
  loadPhase = $state('');
  /** Why the last load failed, in words; cleared when a new load starts. */
  loadError = $state('');
  loading = $state(false);
  active = $state<{ name: string; path: string; hasMmproj: boolean } | null>(null);
  /** The model the main server last reported ready (an extra instance in chat is not it). */
  private mainServerModelPath: string | null = null;
  private host: LocalModelsHost;

  constructor(host: LocalModelsHost) {
    this.host = host;
  }

  /**
   * The loaded model follows the server, not the last button pressed: set
   * when the main server reports ready (also after the app restarts), cleared
   * when it stops or fails.
   */
  syncFromStatus(status: { state?: unknown; model_path?: string | null } | null) {
    const path = typeof status?.model_path === 'string' ? status.model_path : null;
    const state = typeof status?.state === 'string' ? status.state : status?.state ? 'error' : undefined;
    if (state === 'ready' && path) {
      this.mainServerModelPath = path;
      if (this.active?.path?.toLowerCase() !== path.toLowerCase()) {
        const name = path.split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') || path;
        this.active = {
          name,
          path,
          hasMmproj: !!activeLoadConfig(this.host.getConfig().llm?.local as Record<string, unknown> | undefined).mmproj_path
        };
      }
      return;
    }
    if (this.loading) return;
    if (state === 'idle' || state === 'error') {
      const was = this.mainServerModelPath;
      this.mainServerModelPath = null;
      if (this.active && (!was || this.active.path.toLowerCase() === was.toLowerCase())) {
        this.active = null;
      }
    }
  }

  /**
   * Opens the load settings for `model`, filled from that model's own saved
   * config (auto for anything it never had). The dialog appears once its
   * fields are ready, so it never shows the previous model's values first.
   */
  async openLoadDialog(model: LocalModelLoadTarget, options: { asInstance?: boolean } = {}) {
    if (!model.path) return;
    if (this.loading) {
      this.loadTarget = model;
      return;
    }
    const opening = ++this.loadOpenToken;
    const config = this.host.getConfig();
    const runtimePath = config.llm?.local?.runtime_path || '';
    const detectedProjector = await this.detectMmprojForModel(model.path);
    if (opening !== this.loadOpenToken) return;
    const resolved = resolveLocalModelLoadState({ config, model, runtimePath, mmprojPath: detectedProjector });
    this.loadAsInstance = !!options.asInstance;
    this.loadShare = false;
    this.loadProgress = 0;
    this.loadPhase = '';
    this.loadError = '';
    this.loadRuntimePath = resolved.runtimePath;
    this.loadContextLength = resolved.contextLength;
    this.loadGpuLayers = resolved.gpuLayers;
    this.loadCpuThreads = resolved.cpuThreads;
    this.loadBatchSize = resolved.batchSize;
    this.loadFlashAttention = resolved.flashAttention;
    this.loadOffloadKvCache = resolved.offloadKvCache;
    this.loadKeepInMemory = resolved.keepInMemory;
    this.loadMmap = resolved.mmap;
    this.loadSeed = resolved.seed;
    this.loadParallel = resolved.parallel;
    this.loadRopeFreqBase = resolved.ropeFreqBase;
    this.loadRopeFreqScale = resolved.ropeFreqScale;
    this.loadCacheTypeK = resolved.cacheTypeK;
    this.loadCacheTypeV = resolved.cacheTypeV;
    this.loadMmprojPath = resolved.mmprojPath;
    this.loadThinkingMode = resolved.thinkingMode;
    this.loadMtpEnabled = resolved.mtpEnabled;
    this.loadMtpDraftPath = resolved.mtpDraftPath;
    this.loadMtpDraftNMax = resolved.mtpDraftNMax;
    this.loadCpuMoe = resolved.cpuMoe;
    this.loadNCpuMoe = resolved.nCpuMoe;
    this.loadContextShift = resolved.contextShift;
    this.loadCacheRamMb = resolved.cacheRamMb;
    this.loadCacheReuse = resolved.cacheReuse;
    this.loadSwaFull = resolved.swaFull;
    this.loadSplitMode = resolved.splitMode;
    this.loadTarget = model;
  }

  /** The load dialog's current values as one state (what Load saves and launches). */
  get loadState(): LocalModelLoadState {
    return {
      contextLength: this.loadContextLength,
      gpuLayers: this.loadGpuLayers,
      cpuThreads: this.loadCpuThreads,
      batchSize: this.loadBatchSize,
      runtimePath: this.loadRuntimePath,
      flashAttention: this.loadFlashAttention,
      offloadKvCache: this.loadOffloadKvCache,
      keepInMemory: this.loadKeepInMemory,
      mmap: this.loadMmap,
      seed: this.loadSeed,
      parallel: this.loadParallel,
      ropeFreqBase: this.loadRopeFreqBase,
      ropeFreqScale: this.loadRopeFreqScale,
      cacheTypeK: this.loadCacheTypeK,
      cacheTypeV: this.loadCacheTypeV,
      mmprojPath: this.loadMmprojPath,
      thinkingMode: this.loadThinkingMode,
      mtpEnabled: this.loadMtpEnabled,
      mtpDraftPath: this.loadMtpDraftPath,
      mtpDraftNMax: this.loadMtpDraftNMax,
      cpuMoe: this.loadCpuMoe,
      nCpuMoe: this.loadNCpuMoe,
      contextShift: this.loadContextShift,
      cacheRamMb: this.loadCacheRamMb,
      cacheReuse: this.loadCacheReuse,
      swaFull: this.loadSwaFull,
      splitMode: this.loadSplitMode
    };
  }

  /** Hides the dialog. A load in progress keeps running and reporting. */
  closeLoadDialog() {
    this.loadTarget = null;
    this.loadAsInstance = false;
    if (this.loading) return;
    this.loadProgress = 0;
    this.loadPhase = '';
  }

  async detectMmprojForModel(modelPath: string): Promise<string> {
    const candidates = await this.listProjectorCandidates(modelPath);
    return candidates[0] || '';
  }

  async listProjectorCandidates(modelPath: string): Promise<string[]> {
    if (!modelPath || !isElectron()) return [];
    try {
      const candidates = await listMmprojCandidates(modelPath);
      return Array.isArray(candidates) ? candidates : [];
    } catch {
      return [];
    }
  }

  /**
   * Mirrors llama-server's real startup stages onto the load dialog while the
   * launch is in flight. Returns an unsubscribe function; the caller owns it.
   */
  private async subscribeToLoadProgress(): Promise<() => void> {
    if (!isElectron()) return () => {};
    try {
      const unlisten = await onSupervisorEvent((event) => {
        const progress = Number((event as { load_progress?: unknown }).load_progress);
        const phase = (event as { load_phase?: unknown }).load_phase;
        if (Number.isFinite(progress) && progress > 0) {
          this.loadProgress = Math.min(95, 24 + Math.round(progress * 0.71));
        }
        if (typeof phase === 'string' && phase) this.loadPhase = phase;
      });
      return unlisten;
    } catch {
      return () => {};
    }
  }

  /** The full launch config from the dialog, for another instance (no port/host: main picks them). */
  private buildInstanceLaunchConfig(path: string): Record<string, unknown> {
    const num = (value: unknown) => (value === '' || value == null || !Number.isFinite(Number(value)) ? undefined : Number(value));
    const config = this.host.getConfig();
    return {
      model_path: path,
      backend_mode: 'auto',
      runtime_path: this.loadRuntimePath || config.llm?.local?.runtime_path || undefined,
      context_length: num(this.loadContextLength) || undefined,
      gpu_offload: num(this.loadGpuLayers),
      cpu_threads: num(this.loadCpuThreads) || undefined,
      batch_size: num(this.loadBatchSize) || undefined,
      flash_attention: this.loadFlashAttention,
      offload_kv_cache: this.loadOffloadKvCache,
      keep_in_memory: this.loadKeepInMemory,
      mmap: this.loadMmap,
      seed: num(this.loadSeed),
      parallel: num(this.loadParallel),
      rope_freq_base: num(this.loadRopeFreqBase),
      rope_freq_scale: num(this.loadRopeFreqScale),
      cache_type_k: this.loadCacheTypeK || undefined,
      cache_type_v: this.loadCacheTypeV || undefined,
      mmproj_path: this.loadMmprojPath || undefined,
      thinking_mode: this.loadThinkingMode === 'auto' ? undefined : this.loadThinkingMode,
      mtp: this.loadMtpEnabled,
      mtp_draft_path: this.loadMtpDraftPath || undefined,
      mtp_draft_n_max: num(this.loadMtpDraftNMax),
      cpu_moe: this.loadCpuMoe,
      n_cpu_moe: num(this.loadNCpuMoe),
      context_shift: this.loadContextShift,
      cache_ram_mb: num(this.loadCacheRamMb),
      cache_reuse: num(this.loadCacheReuse),
      swa_full: this.loadSwaFull,
      split_mode: this.loadSplitMode || undefined
    };
  }

  /** Instance mode: launch next to the running models, leave chat as it is. */
  private async startInstanceFromDialog(path: string) {
    this.loading = true;
    this.loadError = '';
    this.loadProgress = 20;
    this.loadPhase = 'Starting another instance';
    try {
      await invoke('start_instance', { model_path: path, config: this.buildInstanceLaunchConfig(path), share: this.loadShare });
      this.loadTarget = null;
      this.loadAsInstance = false;
    } catch (err) {
      this.loadError = toErrorMessage(err);
    } finally {
      this.loading = false;
      this.loadProgress = 0;
      this.loadPhase = '';
    }
  }

  /**
   * Restarts the selected model with its saved config and the app-wide
   * settings (Settings → Local server's "Apply and restart").
   */
  async reloadLocalModel() {
    const path = this.host.getConfig().llm?.local?.selected_model_path;
    if (!path || this.loading) return;
    this.loading = true;
    this.loadError = '';
    try {
      await loadLocalModel(await loadChatConfig(), path);
      await modelsStore.refreshStatus();
    } catch (error) {
      const message = describeLocalLoadError(toErrorMessage(error));
      this.loadError = message;
      this.active = null;
      void modelsStore.refreshStatus();
      toastStore.error(message);
    } finally {
      this.loading = false;
    }
  }

  async confirmLoad() {
    const target = this.loadTarget;
    if (!target?.path || this.loading) return;
    if (this.loadAsInstance) {
      await this.startInstanceFromDialog(target.path);
      return;
    }
    this.loading = true;
    this.loadError = '';
    this.loadProgress = 5;
    this.loadPhase = 'Preparing load configuration';
    try {
      if (!this.loadMmprojPath && target.path) {
        this.loadMmprojPath = await this.detectMmprojForModel(target.path);
      }
      const loadState = this.loadState;
      const currentConfig = this.host.getConfig();
      await this.host.commitConfig({
        ...currentConfig,
        llm: { ...currentConfig.llm, local: localWithLoadState(currentConfig.llm?.local, target.path, loadState) }
      });
      await this.host.setBackendMode('local');
      this.loadProgress = 12;
      this.loadPhase = 'Saving local model selection';
      await this.host.updateLocalModel({
        id: target.id,
        name: target.name,
        path: target.path,
        source: 'local',
        details: target.details
      });
      const config = await loadChatConfig();
      this.loadProgress = 24;
      this.loadPhase = 'Launching local runtime';
      const stopTrackingProgress = await this.subscribeToLoadProgress();
      try {
        await loadLocalModel(config, target.path);
      } finally {
        stopTrackingProgress();
      }
      this.loadProgress = 96;
      this.loadPhase = 'Refreshing local model state';
      await modelsStore.refreshIndex();
      await modelsStore.refreshStatus();
      this.loadProgress = 100;
      this.loadPhase = 'Model ready';
      this.active = {
        name: target.name || 'local model',
        path: target.path || '',
        hasMmproj: !!this.loadMmprojPath
      };
      toastStore.success(`Model loaded: ${target.name || 'local model'}`);
      if (isElectron()) {
        detectToolSupport().catch(() => {});
        this.host.refreshReasoningCapabilities(true).catch(() => {});
      }
      if (this.loadTarget === target) this.loadTarget = null;
    } catch (error) {
      const message = describeLocalLoadError(toErrorMessage(error));
      this.loadError = message;
      this.active = null;
      void modelsStore.refreshStatus();
      this.loadProgress = 0;
      this.loadPhase = '';
      toastStore.error(message);
    } finally {
      this.loading = false;
    }
  }
}
