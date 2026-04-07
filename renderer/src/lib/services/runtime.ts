import type { AppConfig } from '$lib/types/chat';
import type { LlamaConfig, ModelSession, RecommendedSettings, SupervisorEvent, SupervisorStatus } from '$lib/types/tauri';
import { invoke, listen } from './tauri';

const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11435/v1';

export function resolveLocalBaseUrl(config?: AppConfig): string {
  const raw = config?.llm?.local?.base_url?.trim() || DEFAULT_LOCAL_BASE_URL;
  const normalized = raw.replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function parseHostPort(baseUrl: string): { host: string; port: number } {
  const url = new URL(resolveLocalBaseUrl({ llm: { local: { base_url: baseUrl } } }));
  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  };
}

export async function startLlama(config: LlamaConfig): Promise<string> {
  return invoke<string>('start_llama', { config });
}

export async function stopLlama(): Promise<void> {
  await invoke<void>('stop_llama');
}

export async function getSupervisorStatus(): Promise<SupervisorStatus> {
  return invoke<SupervisorStatus>('get_supervisor_status');
}

export async function supervisorHealthCheck(): Promise<boolean> {
  return invoke<boolean>('supervisor_health_check');
}

export async function getLoadedModels(): Promise<ModelSession[]> {
  return invoke<ModelSession[]>('get_loaded_models');
}

export async function unloadModel(modelId: string): Promise<void> {
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

export async function waitForLocalServer(baseUrl: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  const modelsUrl = `${resolveLocalBaseUrl({ llm: { local: { base_url: baseUrl } } })}/models`;

  let interval = 400;
  const MAX_INTERVAL = 4000;

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error('Aborted');
    try {
      const response = await fetch(modelsUrl, { method: 'GET', signal });
      if (response.ok) return;
    } catch (e) {
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
  const { host, port } = parseHostPort(baseUrl);

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
}): Promise<string> {
  const baseUrl = resolveLocalBaseUrl(args.config);

  try {
    await stopLlama();
  } catch {
    // ignore stop failures before restart
  }

  const settings = await getRecommendedSettings(
    args.modelPath,
    args.contextLength ?? args.config.llm?.local?.context_length,
    args.gpuLayers ?? args.config.llm?.local?.gpu_layers,
    args.runtimePath || args.config.llm?.local?.runtime_path
  );
  const { host, port } = parseHostPort(baseUrl);

  const baseStartConfig: LlamaConfig = {
    model_path: args.modelPath,
    backend_mode: settings.backend,
    host,
    port,
    context_length: args.contextLength ?? settings.context_length,
    gpu_offload: args.gpuLayers ?? settings.gpu_layers,
    cpu_threads: args.cpuThreads ?? settings.cpu_threads,
    batch_size: args.batchSize ?? settings.batch_size,
    flash_attention: args.flashAttention ?? args.config.llm?.local?.flash_attention ?? settings.flash_attention,
    offload_kv_cache: args.offloadKvCache ?? args.config.llm?.local?.offload_kv_cache ?? settings.offload_kv,
    mmap: args.mmap ?? args.config.llm?.local?.mmap ?? settings.use_mmap,
    keep_in_memory: args.keepInMemory ?? args.config.llm?.local?.keep_in_memory ?? true,
    seed: args.seed ?? args.config.llm?.local?.seed ?? undefined,
    parallel: args.parallel ?? args.config.llm?.local?.parallel ?? undefined,
    rope_freq_base: args.ropeFreqBase ?? args.config.llm?.local?.rope_freq_base ?? undefined,
    rope_freq_scale: args.ropeFreqScale ?? args.config.llm?.local?.rope_freq_scale ?? undefined,
    cache_type_k: args.cacheTypeK ?? args.config.llm?.local?.cache_type_k ?? undefined,
    cache_type_v: args.cacheTypeV ?? args.config.llm?.local?.cache_type_v ?? undefined,
    runtime_path: args.runtimePath || args.config.llm?.local?.runtime_path,
    mmproj_path: args.mmprojPath || args.config.llm?.local?.mmproj_path || undefined
  };

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
    return baseUrl;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Failed to load local model'));
}

export async function onSupervisorEvent(handler: (event: SupervisorEvent) => void): Promise<() => void> {
  return listen<SupervisorEvent>('supervisor-event', handler);
}
