import type { AppConfig } from '$lib/types/chat';
import type { LlamaConfig, ModelSession, RecommendedSettings, RuntimeTelemetry, SupervisorEvent, SupervisorStatus } from '$lib/types/bridge';
import { invoke, listen } from './bridge';

const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11435/v1';
let lastLocalLoadSignature: string | null = null;

function normalizeLocalBaseUrl(rawBaseUrl?: string): string {
  const raw = rawBaseUrl?.trim() || DEFAULT_LOCAL_BASE_URL;
  const normalized = raw.replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function toClientSafeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  return url.toString().replace(/\/+$/, '');
}

export function resolveLocalBaseUrl(config?: AppConfig): string {
  return toClientSafeBaseUrl(normalizeLocalBaseUrl(config?.llm?.local?.base_url));
}

function resolveLocalBindBaseUrl(config?: AppConfig): string {
  return normalizeLocalBaseUrl(config?.llm?.local?.base_url);
}

function parseHostPort(baseUrl: string): { host: string; port: number } {
  const url = new URL(normalizeLocalBaseUrl(baseUrl));
  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  };
}

async function startLlama(config: LlamaConfig): Promise<string> {
  return invoke<string>('start_llama', { config });
}

export async function stopLlama(): Promise<void> {
  await invoke<void>('stop_llama');
  lastLocalLoadSignature = null;
}

function buildLocalLoadSignature(config: LlamaConfig): string {
  return JSON.stringify({
    model_path: config.model_path,
    runtime_path: config.runtime_path || null,
    backend_mode: config.backend_mode || 'auto',
    context_length: config.context_length ?? null,
    gpu_offload: config.gpu_offload ?? null,
    cpu_threads: config.cpu_threads ?? null,
    batch_size: config.batch_size ?? null,
    flash_attention: config.flash_attention ?? null,
    offload_kv_cache: config.offload_kv_cache ?? null,
    mmap: config.mmap ?? null,
    keep_in_memory: config.keep_in_memory ?? null,
    seed: config.seed ?? null,
    parallel: config.parallel ?? null,
    rope_freq_base: config.rope_freq_base ?? null,
    rope_freq_scale: config.rope_freq_scale ?? null,
    cache_type_k: config.cache_type_k ?? null,
    cache_type_v: config.cache_type_v ?? null,
    mmproj_path: config.mmproj_path ?? null,
    mtp: config.mtp ?? null,
    mtp_draft_path: config.mtp_draft_path ?? null,
    mtp_draft_n_max: config.mtp_draft_n_max ?? null,
    cpu_moe: config.cpu_moe ?? null,
    n_cpu_moe: config.n_cpu_moe ?? null,
    context_shift: config.context_shift ?? null,
    cache_ram_mb: config.cache_ram_mb ?? null,
    cache_reuse: config.cache_reuse ?? null,
    swa_full: config.swa_full ?? null,
    split_mode: config.split_mode ?? null
  });
}

export async function getSupervisorStatus(): Promise<SupervisorStatus> {
  return invoke<SupervisorStatus>('get_supervisor_status');
}

/** Live /slots readings, or null when the server is down or too old to report. */
export async function getRuntimeTelemetry(): Promise<RuntimeTelemetry | null> {
  return invoke<RuntimeTelemetry | null>('get_runtime_telemetry');
}

async function supervisorHealthCheck(): Promise<boolean> {
  return invoke<boolean>('supervisor_health_check');
}

async function getLoadedModels(): Promise<ModelSession[]> {
  return invoke<ModelSession[]>('get_loaded_models');
}

async function unloadModel(modelId: string): Promise<void> {
  await invoke<void>('unload_model', { modelId });
}

export async function getRecommendedSettings(
  modelPath: string,
  userContext?: number,
  userGpuLayers?: number,
  runtimePath?: string
): Promise<RecommendedSettings> {
  return invoke<RecommendedSettings>('get_recommended_settings', {
    modelPath,
    userContext,
    userGpuLayers,
    runtimePath
  });
}

export interface LocalCommandPreview {
  args: string[];
  command: string;
  runtime_path: string;
}

/**
 * The exact llama-server command a load would run, without running it.
 * Built in main through the same resolver and capability probe as a real
 * launch, so the preview cannot drift from what actually executes.
 */
export async function previewLocalModelCommand(config: Record<string, unknown>): Promise<LocalCommandPreview> {
  return invoke<LocalCommandPreview>('preview_local_model_command', { config });
}

async function waitForLocalServer(baseUrl: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  const modelsUrl = `${toClientSafeBaseUrl(normalizeLocalBaseUrl(baseUrl))}/models`;

  let interval = 400;
  const MAX_INTERVAL = 4000;

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error('Aborted');
    try {
      const response = await fetch(modelsUrl, { method: 'GET', signal });
      if (response.ok) return;
    } catch (_err: unknown) {
      if (signal?.aborted) throw new Error('Aborted');
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 1.5, MAX_INTERVAL);
  }

  throw new Error('Local runtime did not become ready in time');
}

export async function ensureLocalRuntime(config: AppConfig): Promise<string> {
  const modelPath = config.llm?.local?.selected_model_path;
  if (!modelPath) {
    throw new Error('Select a local model in Settings before using local mode');
  }

  const baseUrl = resolveLocalBaseUrl(config);

  try {
    await waitForLocalServer(baseUrl, 1500);
    return baseUrl;
  } catch {
    // start it below
  }

  const settings = await getRecommendedSettings(
    modelPath,
    config.llm?.local?.context_length,
    config.llm?.local?.gpu_layers,
    config.llm?.local?.runtime_path
  );
  const { host, port } = parseHostPort(resolveLocalBindBaseUrl(config));

  await startLlama({
    model_path: modelPath,
    backend_mode: settings.backend,
    host,
    port,
    context_length: settings.context_length,
    gpu_offload: settings.gpu_layers,
    batch_size: settings.batch_size,
    cpu_threads: settings.cpu_threads,
    flash_attention: settings.flash_attention,
    offload_kv_cache: settings.offload_kv,
    mmap: settings.use_mmap,
    keep_in_memory: true,
    runtime_path: config.llm?.local?.runtime_path
  });

  await waitForLocalServer(baseUrl);
  return baseUrl;
}

export async function loadLocalModel(args: {
  config: AppConfig;
  modelPath: string;
  runtimePath?: string;
  contextLength?: number;
  gpuLayers?: number;
  cpuThreads?: number;
  batchSize?: number;
  flashAttention?: boolean;
  offloadKvCache?: boolean;
  keepInMemory?: boolean;
  mmap?: boolean;
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
}): Promise<string> {
  const baseUrl = resolveLocalBaseUrl(args.config);

  const settings = await getRecommendedSettings(
    args.modelPath,
    args.contextLength ?? args.config.llm?.local?.context_length,
    args.gpuLayers ?? args.config.llm?.local?.gpu_layers,
    args.runtimePath || args.config.llm?.local?.runtime_path
  );
  const { host, port } = parseHostPort(resolveLocalBindBaseUrl(args.config));
  const baseStartConfig: LlamaConfig = {
    model_path: args.modelPath,
    backend_mode: settings.backend,
    host,
    port,
    // Sizing is left undefined unless the user picked a number. Backfilling
    // from `settings` here would make every launch look hand-tuned and stop
    // llama.cpp's own --fit from ever running.
    context_length: args.contextLength,
    gpu_offload: args.gpuLayers,
    cpu_threads: args.cpuThreads,
    batch_size: args.batchSize,
    flash_attention: args.flashAttention ?? args.config.llm?.local?.flash_attention ?? settings.flash_attention,
    offload_kv_cache: args.offloadKvCache ?? args.config.llm?.local?.offload_kv_cache ?? settings.offload_kv,
    mmap: args.mmap ?? args.config.llm?.local?.mmap ?? settings.use_mmap,
    keep_in_memory: args.keepInMemory ?? args.config.llm?.local?.keep_in_memory ?? true,
    cpu_moe: args.cpuMoe ?? args.config.llm?.local?.cpu_moe ?? false,
    n_cpu_moe: args.nCpuMoe ?? args.config.llm?.local?.n_cpu_moe ?? undefined,
    context_shift: args.contextShift ?? args.config.llm?.local?.context_shift ?? false,
    cache_ram_mb: args.cacheRamMb ?? args.config.llm?.local?.cache_ram_mb ?? undefined,
    cache_reuse: args.cacheReuse ?? args.config.llm?.local?.cache_reuse ?? undefined,
    swa_full: args.swaFull ?? args.config.llm?.local?.swa_full ?? false,
    split_mode: args.splitMode ?? args.config.llm?.local?.split_mode ?? undefined,
    seed: args.seed ?? args.config.llm?.local?.seed ?? undefined,
    parallel: args.parallel ?? args.config.llm?.local?.parallel ?? undefined,
    rope_freq_base: args.ropeFreqBase ?? args.config.llm?.local?.rope_freq_base ?? undefined,
    rope_freq_scale: args.ropeFreqScale ?? args.config.llm?.local?.rope_freq_scale ?? undefined,
    cache_type_k: args.cacheTypeK ?? args.config.llm?.local?.cache_type_k ?? undefined,
    cache_type_v: args.cacheTypeV ?? args.config.llm?.local?.cache_type_v ?? undefined,
    runtime_path: args.runtimePath || args.config.llm?.local?.runtime_path,
    mmproj_path: args.mmprojPath || args.config.llm?.local?.mmproj_path || undefined,
    disable_thinking: args.disableThinking ?? args.config.llm?.local?.disable_thinking ?? false,
    mtp: args.mtp ?? args.config.llm?.local?.mtp ?? false,
    mtp_draft_path: args.mtpDraftPath || args.config.llm?.local?.mtp_draft_path || undefined,
    mtp_draft_n_max: args.mtpDraftNMax ?? args.config.llm?.local?.mtp_draft_n_max ?? undefined
  };
  const desiredSignature = buildLocalLoadSignature(baseStartConfig);

  try {
    const currentStatus = await getSupervisorStatus();
    const currentModelPath = currentStatus?.active_model || null;
    if (currentModelPath === args.modelPath && lastLocalLoadSignature === desiredSignature) {
      return baseUrl;
    }
  } catch {
    // proceed with load if status check fails
  }

  try {
    await stopLlama();
  } catch {
    // ignore stop failures before restart
  }

  function isGpuOrRuntimeError(error: unknown) {
    const value = String((error as Error)?.message || error || '').toLowerCase();
    return /gpu|vulkan|cuda|cublas|ggml_vulkan|vk_|out of memory|oom|memory allocation|device lost|failed to allocate|terminated before ready|signal:\s*some\(9\)|killed/.test(value);
  }

  const startWithConfig = async (config: LlamaConfig) => {
    await startLlama(config);
    await waitForLocalServer(baseUrl);
  };

  let lastError: unknown = null;
  try {
    await startWithConfig(baseStartConfig);
    lastLocalLoadSignature = desiredSignature;
    return baseUrl;
  } catch (error) {
    lastError = error;
  }

  if (baseStartConfig.runtime_path) {
    try {
      const retryConfig = { ...baseStartConfig };
      delete retryConfig.runtime_path;
      await stopLlama().catch(() => {});
      await startWithConfig(retryConfig);
      lastLocalLoadSignature = buildLocalLoadSignature(retryConfig);
      return baseUrl;
    } catch (error) {
      lastError = error;
    }
  }

  if (Number(baseStartConfig.gpu_offload || 0) > 0 && isGpuOrRuntimeError(lastError)) {
    try {
      const saferConfig: LlamaConfig = {
        ...baseStartConfig,
        runtime_path: undefined,
        gpu_offload: Math.max(0, Math.floor(Number(baseStartConfig.gpu_offload || 0) * 0.5)),
        offload_kv_cache: false,
        batch_size: Math.min(Number(baseStartConfig.batch_size || settings.batch_size || 512), 128),
        cache_type_k: 'f16',
        cache_type_v: 'f16'
      };
      await stopLlama().catch(() => {});
      await startWithConfig(saferConfig);
      lastLocalLoadSignature = buildLocalLoadSignature(saferConfig);
      return baseUrl;
    } catch (error) {
      lastError = error;
    }
  }

  if (Number(baseStartConfig.gpu_offload || 0) > 0 && isGpuOrRuntimeError(lastError)) {
    const maxThreads = Math.max(1, Number(args.config.llm?.local?.cpu_threads || navigator.hardwareConcurrency || 1));
    const cpuSafeConfig: LlamaConfig = {
      ...baseStartConfig,
      runtime_path: undefined,
      context_length: Math.min(Number(baseStartConfig.context_length || settings.context_length || 4096), 2048),
      gpu_offload: 0,
      batch_size: Math.min(Number(baseStartConfig.batch_size || settings.batch_size || 512), 96),
      cpu_threads: Math.max(2, Math.min(maxThreads, Number(baseStartConfig.cpu_threads || maxThreads))),
      flash_attention: false,
      offload_kv_cache: false,
      keep_in_memory: false,
      mmap: true,
      cache_type_k: 'f16',
      cache_type_v: 'f16'
    };
    await stopLlama().catch(() => {});
    await startWithConfig(cpuSafeConfig);
    lastLocalLoadSignature = buildLocalLoadSignature(cpuSafeConfig);
    return baseUrl;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Failed to load local model'));
}

export async function onSupervisorEvent(handler: (event: SupervisorEvent) => void): Promise<() => void> {
  return listen<SupervisorEvent>('supervisor-event', handler);
}
