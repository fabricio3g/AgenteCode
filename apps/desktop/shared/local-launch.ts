/**
 * The one mapping from saved local-model settings (`config.llm.local`) to a
 * llama-server launch config. Every way a local model starts — the load
 * dialog's confirm, the chat's restart after the server slept or crashed, the
 * agent's preflight, a finished download — goes through here, so a model
 * never comes back with settings nobody chose.
 *
 * The rule is llama.cpp's own: a value that is not set is left off the
 * command line, and `--fit` sizes it against real device memory. Nothing here
 * fills a gap with an estimate; an estimate passed as a value pins it and
 * turns `--fit` off for that setting (this is how an 8k context got pinned on
 * every machine with 16 GB of RAM or less).
 *
 * Two layers, as in LM Studio:
 * - app-wide, at the top of `config.llm.local`: the engine (`runtime_path`),
 *   conversations at once (`parallel`) and the address (`base_url`);
 * - per model, in `config.llm.local.load_configs[<model file>]`: only what was
 *   changed for that file. Absent is auto (or llama.cpp's own default), so a
 *   model never opens or starts with another model's context or GPU layers.
 *
 * Configs saved before the per-model layer existed sat at the top of
 * `config.llm.local` and described `selected_model_path`; they are read as
 * that one file's config until the next save moves them (`withLoadConfig`).
 */

/** What can be set for one model file. Every field is optional: absent = auto. */
export type LocalLoadConfig = {
  context_length?: number;
  /** 0 = CPU only; absent = llama.cpp offloads what fits. */
  gpu_layers?: number;
  cpu_threads?: number;
  batch_size?: number;
  flash_attention?: boolean;
  offload_kv_cache?: boolean;
  keep_in_memory?: boolean;
  mmap?: boolean;
  seed?: number;
  rope_freq_base?: number;
  rope_freq_scale?: number;
  cache_type_k?: string;
  cache_type_v?: string;
  mmproj_path?: string;
  thinking_mode?: 'off' | 'on';
  mtp?: boolean;
  mtp_draft_path?: string;
  mtp_draft_n_max?: number;
  cpu_moe?: boolean;
  n_cpu_moe?: number;
  context_shift?: boolean;
  cache_ram_mb?: number;
  cache_reuse?: number;
  swa_full?: boolean;
  split_mode?: string;
};

/** The per-model keys; everything else in `config.llm.local` is app-wide. */
const LOAD_CONFIG_KEYS = [
  'context_length', 'gpu_layers', 'cpu_threads', 'batch_size', 'flash_attention', 'offload_kv_cache',
  'keep_in_memory', 'mmap', 'seed', 'rope_freq_base', 'rope_freq_scale', 'cache_type_k', 'cache_type_v',
  'mmproj_path', 'thinking_mode', 'mtp', 'mtp_draft_path', 'mtp_draft_n_max', 'cpu_moe', 'n_cpu_moe',
  'context_shift', 'cache_ram_mb', 'cache_reuse', 'swa_full', 'split_mode'
] as const satisfies ReadonlyArray<keyof LocalLoadConfig>;

/** Legacy top-level keys that described one model and are cleared on save. */
const LEGACY_KEYS: string[] = [...LOAD_CONFIG_KEYS, 'gpu_offload', 'disable_thinking'];

/**
 * llama.cpp's behaviour when a switch is left alone. Saving a switch at its
 * default stores nothing, so "unchanged" stays unchanged if the default moves.
 */
const LOAD_CONFIG_DEFAULTS = {
  flash_attention: true,
  offload_kv_cache: true,
  keep_in_memory: false,
  mmap: true,
  mtp: false,
  cpu_moe: false,
  context_shift: false,
  swa_full: false
} as const;

/** The launch fields main's `buildLlamaArgs` understands (renderer `LlamaConfig`). */
export type LocalLaunchConfig = {
  model_path: string;
  backend_mode: 'auto';
  host: string;
  port: number;
  runtime_path?: string;
  parallel?: number;
  context_length?: number;
  gpu_offload?: number;
  cpu_threads?: number;
  batch_size?: number;
  flash_attention?: boolean;
  offload_kv_cache?: boolean;
  keep_in_memory?: boolean;
  mmap?: boolean;
  seed?: number;
  rope_freq_base?: number;
  rope_freq_scale?: number;
  cache_type_k?: string;
  cache_type_v?: string;
  mmproj_path?: string;
  thinking_mode?: 'off' | 'on';
  mtp?: boolean;
  mtp_draft_path?: string;
  mtp_draft_n_max?: number;
  cpu_moe?: boolean;
  n_cpu_moe?: number;
  context_shift?: boolean;
  cache_ram_mb?: number;
  cache_reuse?: number;
  swa_full?: boolean;
  split_mode?: string;
};

type Saved = Record<string, unknown> | null | undefined;

const DEFAULT_BASE_URL = 'http://127.0.0.1:11435/v1';

/** A positive count, or undefined (auto). `0` counts only where it is meaningful. */
function count(value: unknown, allowZero = false): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return undefined;
  return n > 0 || (allowZero && n === 0) ? n : undefined;
}

function decimal(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function text(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || undefined;
}

/** The key a model file's config is stored under: one spelling per file. */
function modelKey(modelPath: string): string {
  return String(modelPath || '').trim().replace(/\\/g, '/').toLowerCase();
}

/** A clean per-model config: valid values only, switches at their default dropped. */
function normalizeLoadConfig(raw: Record<string, unknown> | null | undefined): LocalLoadConfig {
  const value = raw ?? {};
  const config: Record<string, unknown> = {
    context_length: count(value.context_length),
    gpu_layers: count(value.gpu_layers ?? value.gpu_offload, true),
    cpu_threads: count(value.cpu_threads),
    batch_size: count(value.batch_size),
    flash_attention: flag(value.flash_attention),
    offload_kv_cache: flag(value.offload_kv_cache),
    keep_in_memory: flag(value.keep_in_memory),
    mmap: flag(value.mmap),
    seed: count(value.seed, true),
    rope_freq_base: decimal(value.rope_freq_base),
    rope_freq_scale: decimal(value.rope_freq_scale),
    cache_type_k: text(value.cache_type_k),
    cache_type_v: text(value.cache_type_v),
    mmproj_path: text(value.mmproj_path),
    thinking_mode: thinking(value),
    mtp: flag(value.mtp),
    mtp_draft_path: text(value.mtp_draft_path),
    mtp_draft_n_max: count(value.mtp_draft_n_max),
    cpu_moe: flag(value.cpu_moe),
    n_cpu_moe: count(value.n_cpu_moe),
    context_shift: flag(value.context_shift),
    cache_ram_mb: count(value.cache_ram_mb, true),
    cache_reuse: count(value.cache_reuse),
    swa_full: flag(value.swa_full),
    split_mode: text(value.split_mode)
  };
  for (const [key, standard] of Object.entries(LOAD_CONFIG_DEFAULTS)) {
    if (config[key] === standard) delete config[key];
  }
  return prune(config) as LocalLoadConfig;
}

/**
 * A legacy top-level config, keeping only what someone can have chosen.
 * Older builds wrote threads, batch size, cache types and memory locking into
 * every config (a normalizer's defaults and the "recommended" pre-fill), and
 * seeded a 4,096 context and 0 GPU layers; carried over, those would pin
 * values nobody picked. Context, thinking, projector, MTP, MoE, RoPE and seed
 * were only ever written by a person.
 */
function legacyLoadConfig(saved: Record<string, unknown>): LocalLoadConfig {
  const legacy = normalizeLoadConfig(saved);
  delete legacy.cpu_threads;
  delete legacy.batch_size;
  delete legacy.keep_in_memory;
  delete legacy.cache_type_k;
  delete legacy.cache_type_v;
  if (legacy.gpu_layers === 0) delete legacy.gpu_layers;
  if (legacy.context_length === 4096) delete legacy.context_length;
  return legacy;
}

/**
 * The config saved for `modelPath`: its own entry, else (once) the legacy
 * top-level values when they were saved for this same file, else nothing.
 */
export function savedLoadConfig(saved: Saved, modelPath: string): LocalLoadConfig {
  const configs = (saved?.load_configs ?? {}) as Record<string, Record<string, unknown>>;
  // Keys are written normalized, but a hand-edited config may spell the path
  // another way; it is still the same file.
  const key = modelKey(modelPath);
  const own = configs[key] ?? Object.entries(configs).find(([other]) => modelKey(other) === key)?.[1];
  if (own) return normalizeLoadConfig(own);
  return sameFile(saved?.selected_model_path, modelPath) ? legacyLoadConfig(saved as Record<string, unknown>) : {};
}

/**
 * `config.llm.local` with `modelPath`'s config replaced by `next` (cleaned),
 * and the legacy top-level per-model values moved out of the way. A legacy
 * config that belonged to another file becomes that file's entry first, so
 * nothing anyone chose is lost.
 */
export function withLoadConfig<T extends Record<string, unknown>>(saved: T | null | undefined, modelPath: string, next: Record<string, unknown>): T {
  const base: Record<string, unknown> = { ...(saved ?? {}) };
  const configs = { ...((base.load_configs ?? {}) as Record<string, unknown>) };
  const legacyFile = text(base.selected_model_path);
  if (legacyFile && !configs[modelKey(legacyFile)] && modelKey(legacyFile) !== modelKey(modelPath)) {
    const legacy = legacyLoadConfig(base);
    if (Object.keys(legacy).length) configs[modelKey(legacyFile)] = legacy;
  }
  for (const key of LEGACY_KEYS) delete base[key];
  const clean = normalizeLoadConfig(next);
  if (Object.keys(clean).length) configs[modelKey(modelPath)] = clean;
  else delete configs[modelKey(modelPath)];
  base.load_configs = configs;
  return base as T;
}

/** The selected model's own config (`selected_model_path`), or nothing when none is selected. */
export function activeLoadConfig(saved: Saved): LocalLoadConfig {
  const selected = text(saved?.selected_model_path);
  return selected ? savedLoadConfig(saved, selected) : {};
}

/** Where the server listens, from the saved base URL (`0.0.0.0` stays a bind address). */
export function localBindAddress(saved: Saved): { host: string; port: number } {
  try {
    const raw = text(saved?.base_url) || DEFAULT_BASE_URL;
    const url = new URL(raw);
    return { host: url.hostname || '127.0.0.1', port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80 };
  } catch {
    return { host: '127.0.0.1', port: 11435 };
  }
}

function sameFile(a: unknown, b: unknown): boolean {
  const left = text(a)?.replace(/\\/g, '/').toLowerCase();
  const right = text(b)?.replace(/\\/g, '/').toLowerCase();
  return !!left && left === right;
}

/** `thinking_mode` with the legacy `disable_thinking` boolean folded in; auto is omitted. */
function thinking(saved: Saved): 'off' | 'on' | undefined {
  const mode = saved?.thinking_mode;
  if (mode === 'off' || mode === 'on') return mode;
  if (mode === 'auto') return undefined;
  return saved?.disable_thinking === true ? 'off' : undefined;
}

/**
 * The launch config for `modelPath`: the app-wide settings plus that file's
 * own config (`savedLoadConfig`). Anything unset is left to llama.cpp.
 */
export function launchConfigFromSaved(saved: Saved, modelPath: string): LocalLaunchConfig {
  const { host, port } = localBindAddress(saved);
  const appWide: LocalLaunchConfig = {
    model_path: modelPath,
    backend_mode: 'auto',
    host,
    port,
    runtime_path: text(saved?.runtime_path),
    parallel: count(saved?.parallel)
  };
  const { gpu_layers, ...model } = savedLoadConfig(saved, modelPath);
  return prune({ ...appWide, ...model, gpu_offload: gpu_layers });
}

/** Drops unset keys, so "auto" is absence and two equal launches compare equal. */
function prune<T extends object>(config: T): T {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) as T;
}

/**
 * A stable identity for a launch: two configs that would start the same
 * server compare equal. Every launch field takes part, so a changed setting
 * (thinking included) always reloads.
 */
export function launchSignature(config: Record<string, unknown>): string {
  const entries = Object.entries(config)
    .filter(([key, value]) => key !== 'api_key' && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, key === 'model_path' || key === 'runtime_path' || key === 'mmproj_path' ? String(value).replace(/\\/g, '/').toLowerCase() : value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}
