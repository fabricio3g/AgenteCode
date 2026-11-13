import type { AppConfig, LocalThinkingMode } from '$lib/types/chat';
import type { LocalModelLoadTarget } from '$lib/stores/app-store-types';
import { savedLoadConfig, withLoadConfig, type LocalLoadConfig } from '$shared/local-launch';

/** Chats the on-device server answers at once when the setting is unset (llama.cpp's auto). */
export const DEFAULT_LOCAL_PARALLEL = 4;

/**
 * The load dialog's editable copy of one model's config (strings for the
 * text fields). `''` is auto everywhere: the setting is left off the command
 * line and llama.cpp decides. Engine and slots are app-wide (`config.llm.local`);
 * everything else belongs to the model (`config.llm.local.load_configs`).
 */
export interface LocalModelLoadState {
  contextLength: string;
  gpuLayers: string;
  cpuThreads: string;
  batchSize: string;
  /** App-wide: the engine every model runs on. */
  runtimePath: string;
  flashAttention: boolean;
  offloadKvCache: boolean;
  keepInMemory: boolean;
  mmap: boolean;
  seed: string;
  /** App-wide: conversations the server answers at once. */
  parallel: string;
  ropeFreqBase: string;
  ropeFreqScale: string;
  /** '' = the server's default for the device. */
  cacheTypeK: string;
  cacheTypeV: string;
  mmprojPath: string;
  /** 'auto' omits --reasoning so llama.cpp detects from the template. */
  thinkingMode: LocalThinkingMode;
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

export function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Normalizes a thinking mode from saved config or the legacy
 * `disable_thinking` boolean. Anything unrecognized falls back to 'auto'
 * (omit --reasoning).
 */
export function normalizeThinkingMode(...values: unknown[]): LocalThinkingMode {
  for (const value of values) {
    if (value === 'off' || value === 'on' || value === 'auto') return value;
    if (value === true) return 'off';
  }
  return 'auto';
}

const asText = (value: unknown) => (value === undefined || value === null ? '' : String(value));

/**
 * What the dialog opens with for `model`: its own saved config, or auto for
 * everything it never had. Nothing comes from another model, from the last
 * load, or from a recommendation — "Use recommended" applies that on request.
 */
export function resolveLocalModelLoadState(params: {
  config: AppConfig;
  model: LocalModelLoadTarget;
  runtimePath: string;
  /** A projector found next to the model, used when none was chosen before. */
  mmprojPath?: string;
}): LocalModelLoadState {
  const local = params.config.llm?.local as Record<string, unknown> | undefined;
  const own = params.model.path ? savedLoadConfig(local, params.model.path) : {};
  return {
    contextLength: asText(own.context_length),
    gpuLayers: asText(own.gpu_layers),
    cpuThreads: asText(own.cpu_threads),
    batchSize: asText(own.batch_size),
    runtimePath: params.runtimePath,
    flashAttention: own.flash_attention ?? true,
    offloadKvCache: own.offload_kv_cache ?? true,
    keepInMemory: own.keep_in_memory ?? false,
    mmap: own.mmap ?? true,
    seed: asText(own.seed),
    // Unset is upstream's auto: 4 slots sharing one KV pool.
    parallel: String(Number(local?.parallel) || DEFAULT_LOCAL_PARALLEL),
    ropeFreqBase: asText(own.rope_freq_base),
    ropeFreqScale: asText(own.rope_freq_scale),
    cacheTypeK: own.cache_type_k ?? '',
    cacheTypeV: own.cache_type_v ?? '',
    mmprojPath: own.mmproj_path ?? params.mmprojPath ?? '',
    thinkingMode: normalizeThinkingMode(own.thinking_mode),
    mtpEnabled: own.mtp ?? false,
    mtpDraftPath: own.mtp_draft_path ?? '',
    mtpDraftNMax: asText(own.mtp_draft_n_max),
    cpuMoe: own.cpu_moe ?? false,
    nCpuMoe: asText(own.n_cpu_moe),
    contextShift: own.context_shift ?? false,
    cacheRamMb: asText(own.cache_ram_mb),
    cacheReuse: asText(own.cache_reuse),
    swaFull: own.swa_full ?? false,
    splitMode: own.split_mode ?? ''
  };
}

const num = (value: string) => (value.trim() === '' ? undefined : Number(value));

/** The model's own config from the dialog; `normalizeLoadConfig` drops auto and defaults. */
export function loadConfigFromState(state: LocalModelLoadState): LocalLoadConfig {
  return {
    context_length: num(state.contextLength),
    gpu_layers: num(state.gpuLayers),
    cpu_threads: num(state.cpuThreads),
    batch_size: num(state.batchSize),
    flash_attention: state.flashAttention,
    offload_kv_cache: state.offloadKvCache,
    keep_in_memory: state.keepInMemory,
    mmap: state.mmap,
    seed: num(state.seed),
    rope_freq_base: num(state.ropeFreqBase),
    rope_freq_scale: num(state.ropeFreqScale),
    cache_type_k: state.cacheTypeK || undefined,
    cache_type_v: state.cacheTypeV || undefined,
    mmproj_path: state.mmprojPath || undefined,
    thinking_mode: state.thinkingMode === 'auto' ? undefined : state.thinkingMode,
    mtp: state.mtpEnabled,
    mtp_draft_path: state.mtpDraftPath || undefined,
    mtp_draft_n_max: num(state.mtpDraftNMax),
    cpu_moe: state.cpuMoe,
    n_cpu_moe: num(state.nCpuMoe),
    context_shift: state.contextShift,
    cache_ram_mb: num(state.cacheRamMb),
    cache_reuse: num(state.cacheReuse),
    swa_full: state.swaFull,
    split_mode: state.splitMode || undefined
  };
}

/**
 * `config.llm.local` after a load of `modelPath` with the dialog's values:
 * that model's own config replaced, the app-wide engine and slots set. What
 * Load saves, and what the command preview launches from.
 */
export function localWithLoadState<T extends object>(local: T | null | undefined, modelPath: string, state: LocalModelLoadState): T {
  const parallel = Number(state.parallel);
  return {
    ...withLoadConfig(local as Record<string, unknown> | undefined, modelPath, loadConfigFromState(state)),
    runtime_path: state.runtimePath || undefined,
    parallel: Number.isFinite(parallel) && parallel > 0 ? parallel : null
  } as unknown as T;
}
