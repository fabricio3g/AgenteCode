import type { AppConfig } from '$lib/types/chat';
import type { LocalModelLoadTarget } from '$lib/stores/app-store-types';

const LOCAL_MODEL_SETTINGS_KEY = 'chatealm_model_load_settings_by_model';

export interface RecommendedLocalModelSettings {
  context_length?: number;
  gpu_layers?: number;
  cpu_threads?: number;
  batch_size?: number;
  flash_attention?: boolean;
  offload_kv?: boolean;
  use_mmap?: boolean;
}

export interface LocalModelLoadState {
  /** Empty string means "auto" — llama.cpp sizes it with --fit. */
  contextLength: string;
  /** Empty string means "auto". */
  gpuLayers: string;
  cpuThreads: string;
  batchSize: string;
  runtimePath: string;
  flashAttention: boolean;
  offloadKvCache: boolean;
  keepInMemory: boolean;
  mmap: boolean;
  seed: string;
  parallel: string;
  ropeFreqBase: string;
  ropeFreqScale: string;
  cacheTypeK: string;
  cacheTypeV: string;
  mmprojPath: string;
  rememberSettings: boolean;
  disableThinking: boolean;
  mtpEnabled: boolean;
  mtpDraftPath: string;
  mtpDraftNMax: string;
  cpuMoe: boolean;
  /** Blank keeps all experts on CPU when `cpuMoe` is on; a number offloads the first N layers. */
  nCpuMoe: string;
  contextShift: boolean;
  cacheRamMb: string;
  cacheReuse: string;
  swaFull: boolean;
  splitMode: string;
}

export interface LocalModelRuntimeRequest {
  config: AppConfig;
  modelPath: string;
  runtimePath?: string;
  contextLength?: number;
  gpuLayers?: number;
  cpuThreads?: number;
  batchSize?: number;
  flashAttention: boolean;
  offloadKvCache: boolean;
  keepInMemory: boolean;
  mmap: boolean;
  seed?: number;
  parallel?: number;
  ropeFreqBase?: number;
  ropeFreqScale?: number;
  cacheTypeK?: string;
  cacheTypeV?: string;
  mmprojPath?: string;
  disableThinking?: boolean;
  mtp?: boolean;
  mtpDraftPath?: string;
  mtpDraftNMax?: number;
  cpuMoe?: boolean;
  nCpuMoe?: number;
  contextShift?: boolean;
  cacheRamMb?: number;
  cacheReuse?: number;
  swaFull?: boolean;
  splitMode?: string;
}

export function readRememberedLocalModelSettings(): Record<string, Record<string, unknown>> {
  try {
    const raw = localStorage.getItem(LOCAL_MODEL_SETTINGS_KEY) || '{}';
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeRememberedLocalModelSettings(store: Record<string, Record<string, unknown>>) {
  try {
    localStorage.setItem(LOCAL_MODEL_SETTINGS_KEY, JSON.stringify(store));
  } catch {
    // ignore local storage failures
  }
}

export function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function resolveLocalModelLoadState(params: {
  remembered: Record<string, unknown>;
  config: AppConfig;
  model: LocalModelLoadTarget;
  runtimePath: string;
  recommended?: RecommendedLocalModelSettings | null;
  hardwareConcurrency?: number;
  mmprojPath?: string;
}): LocalModelLoadState {
  const { remembered, config, model, recommended, runtimePath } = params;
  const local = config.llm?.local;
  const cpuFallback = params.hardwareConcurrency ?? 4;

  // Context and GPU layers default to auto (''). Only a value the user chose
  // before — remembered, or saved into config — pins them; the recommendation
  // is shown as a preset the user can apply, not silently applied for them.
  const rememberedContext = pickNumber(remembered.context_length, local?.context_length);
  const rememberedGpuLayers = pickNumber(remembered.gpu_offload, local?.gpu_layers);

  return {
    contextLength: rememberedContext != null ? String(rememberedContext) : '',
    gpuLayers: rememberedGpuLayers != null ? String(rememberedGpuLayers) : '',
    cpuThreads: String(pickNumber(
      remembered.cpu_threads,
      recommended?.cpu_threads,
      local?.cpu_threads,
      cpuFallback,
      4
    ) ?? 4),
    batchSize: String(pickNumber(
      remembered.batch_size,
      recommended?.batch_size,
      local?.batch_size,
      512
    ) ?? 512),
    runtimePath,
    flashAttention: remembered.flash_attention != null ? Boolean(remembered.flash_attention) : (local?.flash_attention ?? recommended?.flash_attention ?? true),
    offloadKvCache: remembered.offload_kv_cache != null ? Boolean(remembered.offload_kv_cache) : (local?.offload_kv_cache ?? recommended?.offload_kv ?? true),
    keepInMemory: remembered.keep_in_memory != null ? Boolean(remembered.keep_in_memory) : (local?.keep_in_memory ?? true),
    mmap: remembered.mmap != null ? Boolean(remembered.mmap) : (local?.mmap ?? recommended?.use_mmap ?? true),
    seed: remembered.seed != null ? String(remembered.seed) : String(local?.seed || ''),
    parallel: String(Number(remembered.parallel || local?.parallel || 1)),
    ropeFreqBase: remembered.rope_freq_base != null ? String(remembered.rope_freq_base) : String(local?.rope_freq_base || ''),
    ropeFreqScale: remembered.rope_freq_scale != null ? String(remembered.rope_freq_scale) : String(local?.rope_freq_scale || ''),
    cacheTypeK: String(remembered.cache_type_k || local?.cache_type_k || 'f16'),
    cacheTypeV: String(remembered.cache_type_v || local?.cache_type_v || 'f16'),
    mmprojPath: params.mmprojPath || '',
    disableThinking: remembered.disable_thinking ? Boolean(remembered.disable_thinking) : (local?.disable_thinking ?? false),
    mtpEnabled: remembered.mtp != null ? Boolean(remembered.mtp) : (local?.mtp ?? false),
    mtpDraftPath: remembered.mtp_draft_path != null ? String(remembered.mtp_draft_path) : (local?.mtp_draft_path ? String(local.mtp_draft_path) : ''),
    mtpDraftNMax: remembered.mtp_draft_n_max != null ? String(remembered.mtp_draft_n_max) : (local?.mtp_draft_n_max != null ? String(local.mtp_draft_n_max) : ''),
    cpuMoe: remembered.cpu_moe != null ? Boolean(remembered.cpu_moe) : (local?.cpu_moe ?? false),
    nCpuMoe: remembered.n_cpu_moe != null ? String(remembered.n_cpu_moe) : (local?.n_cpu_moe != null ? String(local.n_cpu_moe) : ''),
    contextShift: remembered.context_shift != null ? Boolean(remembered.context_shift) : (local?.context_shift ?? false),
    cacheRamMb: remembered.cache_ram_mb != null ? String(remembered.cache_ram_mb) : (local?.cache_ram_mb != null ? String(local.cache_ram_mb) : ''),
    cacheReuse: remembered.cache_reuse != null ? String(remembered.cache_reuse) : (local?.cache_reuse != null ? String(local.cache_reuse) : ''),
    swaFull: remembered.swa_full != null ? Boolean(remembered.swa_full) : (local?.swa_full ?? false),
    splitMode: String(remembered.split_mode || local?.split_mode || ''),
    rememberSettings: Object.keys(remembered).length > 0
  };
}

/** Shared by the config patch and the remembered-settings entry. */
function buildModernFlagFields(state: LocalModelLoadState) {
  return {
    cpu_moe: state.cpuMoe,
    n_cpu_moe: state.nCpuMoe ? Number(state.nCpuMoe) : null,
    context_shift: state.contextShift,
    cache_ram_mb: state.cacheRamMb ? Number(state.cacheRamMb) : null,
    cache_reuse: state.cacheReuse ? Number(state.cacheReuse) : null,
    swa_full: state.swaFull,
    split_mode: state.splitMode || undefined
  };
}

export function buildLocalModelSettingsPatch(state: LocalModelLoadState) {
  return {
    context_length: state.contextLength ? Number(state.contextLength) : undefined,
    gpu_layers: state.gpuLayers === '' ? undefined : Number(state.gpuLayers),
    cpu_threads: state.cpuThreads ? Number(state.cpuThreads) : undefined,
    batch_size: state.batchSize ? Number(state.batchSize) : undefined,
    flash_attention: state.flashAttention,
    offload_kv_cache: state.offloadKvCache,
    keep_in_memory: state.keepInMemory,
    mmap: state.mmap,
    seed: state.seed ? Number(state.seed) : null,
    parallel: state.parallel ? Number(state.parallel) : null,
    rope_freq_base: state.ropeFreqBase ? Number(state.ropeFreqBase) : null,
    rope_freq_scale: state.ropeFreqScale ? Number(state.ropeFreqScale) : null,
    cache_type_k: state.cacheTypeK || undefined,
    cache_type_v: state.cacheTypeV || undefined,
    runtime_path: state.runtimePath || undefined,
    mmproj_path: state.mmprojPath || undefined,
    disable_thinking: state.disableThinking,
    mtp: state.mtpEnabled,
    mtp_draft_path: state.mtpDraftPath || null,
    mtp_draft_n_max: state.mtpDraftNMax ? Number(state.mtpDraftNMax) : null,
    ...buildModernFlagFields(state)
  };
}

export function buildRememberedLocalModelSettingsEntry(state: LocalModelLoadState) {
  return {
    context_length: state.contextLength ? Number(state.contextLength) : undefined,
    gpu_offload: state.gpuLayers === '' ? undefined : Number(state.gpuLayers),
    cpu_threads: state.cpuThreads ? Number(state.cpuThreads) : undefined,
    batch_size: state.batchSize ? Number(state.batchSize) : undefined,
    flash_attention: state.flashAttention,
    offload_kv_cache: state.offloadKvCache,
    keep_in_memory: state.keepInMemory,
    mmap: state.mmap,
    seed: state.seed ? Number(state.seed) : null,
    parallel: state.parallel ? Number(state.parallel) : null,
    rope_freq_base: state.ropeFreqBase ? Number(state.ropeFreqBase) : null,
    rope_freq_scale: state.ropeFreqScale ? Number(state.ropeFreqScale) : null,
    cache_type_k: state.cacheTypeK || 'f16',
    cache_type_v: state.cacheTypeV || 'f16',
    runtime_path: state.runtimePath || '',
    disable_thinking: state.disableThinking,
    mtp: state.mtpEnabled,
    mtp_draft_path: state.mtpDraftPath || null,
    mtp_draft_n_max: state.mtpDraftNMax ? Number(state.mtpDraftNMax) : null,
    ...buildModernFlagFields(state)
  };
}

export function buildLocalModelRuntimeRequest(params: {
  config: AppConfig;
  target: LocalModelLoadTarget;
  state: LocalModelLoadState;
}): LocalModelRuntimeRequest {
  const settings = buildLocalModelSettingsPatch(params.state);
  return {
    config: {
      ...params.config,
      llm: {
        ...params.config.llm,
        local: {
          ...(params.config.llm?.local || {}),
          selected_model_path: params.target.path,
          model: params.target.name,
          ...settings,
          seed: settings.seed ?? undefined,
          parallel: settings.parallel ?? undefined,
          rope_freq_base: settings.rope_freq_base ?? undefined,
          rope_freq_scale: settings.rope_freq_scale ?? undefined
        }
      }
    },
    modelPath: params.target.path || '',
    runtimePath: settings.runtime_path,
    contextLength: settings.context_length,
    gpuLayers: settings.gpu_layers,
    cpuThreads: settings.cpu_threads,
    batchSize: settings.batch_size,
    flashAttention: params.state.flashAttention,
    offloadKvCache: params.state.offloadKvCache,
    keepInMemory: params.state.keepInMemory,
    mmap: params.state.mmap,
    seed: settings.seed ?? undefined,
    parallel: settings.parallel ?? undefined,
    ropeFreqBase: settings.rope_freq_base ?? undefined,
    ropeFreqScale: settings.rope_freq_scale ?? undefined,
    cacheTypeK: settings.cache_type_k,
    cacheTypeV: settings.cache_type_v,
    mmprojPath: settings.mmproj_path,
    disableThinking: params.state.disableThinking,
    mtp: settings.mtp,
    mtpDraftPath: params.state.mtpDraftPath || settings.mtp_draft_path || undefined,
    mtpDraftNMax: settings.mtp_draft_n_max ?? undefined,
    cpuMoe: params.state.cpuMoe,
    nCpuMoe: settings.n_cpu_moe ?? undefined,
    contextShift: params.state.contextShift,
    cacheRamMb: settings.cache_ram_mb ?? undefined,
    cacheReuse: settings.cache_reuse ?? undefined,
    swaFull: params.state.swaFull,
    splitMode: settings.split_mode
  };
}
