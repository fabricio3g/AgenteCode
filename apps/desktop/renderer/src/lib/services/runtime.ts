import type { AppConfig } from '$lib/types/chat';
import type { LlamaConfig, ModelSession, RecommendedSettings, RuntimeTelemetry, SupervisorEvent, SupervisorStatus } from '$lib/types/bridge';
import { invoke, listen } from './bridge';
import { launchConfigFromSaved, launchSignature, type LocalLaunchConfig } from '$shared/local-launch';

const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11435/v1';
let lastLocalLoadSignature: string | null = null;
let localLoadGeneration = 0;
let localLoad: { signature: string; promise: Promise<string> } | null = null;

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

async function startLlama(config: LlamaConfig): Promise<string> {
  return invoke<string>('start_llama', { config });
}

export async function stopLlama(): Promise<void> {
  localLoadGeneration += 1;
  localLoad = null;
  await invoke<void>('stop_llama');
  lastLocalLoadSignature = null;
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
/** A device a llama-server build can offload to, as `--list-devices` reports it. */
export type RuntimeDevice = { id: string; backend: string; name: string; totalMb: number | null; freeMb: number | null };

/** llama.cpp's own device list for an engine (the configured one when no path is given). */
export async function getRuntimeDevices(runtimePath?: string | null): Promise<{ runtimePath: string | null; devices: RuntimeDevice[] }> {
  return invoke('runtime_devices', { runtimePath: runtimePath || null });
}

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
      const timeout = AbortSignal.timeout(2000);
      const response = await fetch(modelsUrl, { method: 'GET', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      // Newer llama.cpp builds protect /models with the API key: a 401 still
      // means the server is up and answering.
      if (response.ok || response.status === 401) return;
    } catch (_err: unknown) {
      if (signal?.aborted) throw new Error('Aborted');
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 1.5, MAX_INTERVAL);
  }

  throw new Error('Local runtime did not become ready in time');
}

/**
 * The chat path: answer with the server if it is up, otherwise start the
 * selected model with its saved settings — the same launch the load dialog
 * makes. It used to restart with main's "recommended" numbers instead, which
 * pinned an 8k context (and a CPU-only engine choice) after every idle sleep
 * or crash.
 */
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
  return loadLocalModel(config, modelPath);
}

/**
 * Starts `modelPath` with the settings saved for it (see `launchConfigFromSaved`).
 * The one renderer path to llama-server: the dialog saves its choices first and
 * then calls this, and so does the chat when the server is down.
 *
 * A failure is reported as llama.cpp reported it. There is no fallback ladder:
 * it used to retry on another engine, then with half the GPU layers, then on
 * the CPU at a 2,048 context — and said "Model loaded" over a model that was
 * no longer the one chosen.
 */
export async function loadLocalModel(config: AppConfig, modelPath: string): Promise<string> {
  const launch = launchConfigFromSaved(config.llm?.local as Record<string, unknown> | undefined, modelPath);
  const signature = launchSignature(launch);
  if (localLoad?.signature === signature) return localLoad.promise;
  const generation = ++localLoadGeneration;
  const request = { signature, promise: performLocalModelLoad(config, launch, signature, generation) };
  localLoad = request;
  try {
    return await request.promise;
  } finally {
    if (localLoad === request) localLoad = null;
  }
}

async function performLocalModelLoad(config: AppConfig, launch: LocalLaunchConfig, signature: string, generation: number): Promise<string> {
  const checkCurrent = () => {
    if (generation !== localLoadGeneration) throw new Error('Model load cancelled by a stop or a newer load request.');
  };
  const baseUrl = resolveLocalBaseUrl(config);

  // The same launch already serving: nothing to do.
  try {
    const status = await getSupervisorStatus();
    const samePath = (value: string) => value.replace(/\\/g, '/').toLowerCase();
    if (status?.state === 'ready' && samePath(String(status?.model_path || '')) === samePath(launch.model_path) && lastLocalLoadSignature === signature) {
      return baseUrl;
    }
  } catch {
    // proceed with the load if the status check fails
  }

  checkCurrent();
  await startLlama(launch as LlamaConfig);
  checkCurrent();
  // main's start resolves once /health answers and /props has been read; this
  // only confirms the OpenAI endpoint answers too. A large CPU load can take
  // minutes, so the wait is generous rather than a trigger for retries.
  await waitForLocalServer(baseUrl, 180_000);
  checkCurrent();
  lastLocalLoadSignature = signature;
  return baseUrl;
}

export async function onSupervisorEvent(handler: (event: SupervisorEvent) => void): Promise<() => void> {
  return listen<SupervisorEvent>('supervisor-event', handler);
}
