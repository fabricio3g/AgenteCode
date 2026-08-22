import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { getHardwareLimits } from './system-info.ts';
import { ManagedProcess, buildLlamaArgs, buildEmbeddingArgs } from './process-manager.ts';
import {
  resolveRuntimeBinary, listRuntimeBinaries, clearRuntimeSelectionFromConfig
} from './runtime-resolver.ts';
import { getAppPaths } from './paths.ts';
import { resolveRuntimeConfig, readGgufMetadataFields } from './runtime-config-resolver.ts';
import { inspectLlamaServer, supportsLlamaFlag } from './llama-runtime.ts';
import { startLlamaSession, endLlamaSession, llamaSessionHeaders } from './llama-session.ts';
import { setEmbeddingStatus, getEmbeddingStatus as getEmbeddingStatusState } from './embedding-state.ts';

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Managed process instances ──

const llama = new ManagedProcess({
  initialStatus: { state: 'idle', model_id: null, model_path: null, runtime_path: null, port: null },
  onStatusChange(status) { llamaStatus = { ...llamaStatus, ...status }; }
});

const embedding = new ManagedProcess({
  initialStatus: { state: 'idle', port: null },
  onStatusChange(status) { setEmbeddingStatus(status); }
});

let llamaStatus = llama.status;

function isMmprojFileName(fileName: string): boolean {
  return /(^|[-_.])mmproj[-_.].*\.gguf$/i.test(fileName) || /projector.*\.gguf$/i.test(fileName);
}

function resolveModelPath(inputPath: string): string {
  if (!inputPath) return inputPath;
  if (!fs.existsSync(inputPath)) return inputPath;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(inputPath);
  } catch {
    return inputPath;
  }

  if (stat.isFile()) return inputPath;
  if (!stat.isDirectory()) return inputPath;

  const candidates: { fullPath: string; size: number }[] = [];
  const stack = [inputPath];

  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.gguf')) continue;
      if (isMmprojFileName(entry.name)) continue;

      try {
        const size = fs.statSync(fullPath).size;
        candidates.push({ fullPath, size });
      } catch {
        // ignore stat failures
      }
    }
  }

  if (!candidates.length) return inputPath;
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0].fullPath;
}

/**
 * Progress patches arrive far more often than state changes, and they carry no
 * `state` field. Tagging them as `state_change` would make subscribers read a
 * missing state as 'idle' and drop the active model mid-load, so they get their
 * own event type.
 */
function sendSupervisorEvent(
  win: BrowserWindow | null | undefined,
  patch: Record<string, unknown>
): void {
  if (!win || win.isDestroyed()) return;
  const isStateChange = typeof patch.state === 'string';
  win.webContents.send('supervisor-event', {
    type: isStateChange ? 'state_change' : 'load_progress',
    ...(isStateChange ? { from: llamaStatus.state, to: patch.state as string } : {}),
    ...patch
  });
}

function emitStatus(win: BrowserWindow | null | undefined, patch: Record<string, unknown>): void {
  llama.setStatus(patch);
  sendSupervisorEvent(win, patch);
}

/**
 * GET /props reports what the server actually settled on — context size, slot
 * count, resolved model path. With `--fit` deciding sizing, this is the only
 * place those numbers exist; the UI can no longer derive them from our config.
 *
 * /props is not one of llama-server's public endpoints, so it needs the key.
 */
async function fetchServerProps(port: number): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/props`, {
      headers: llamaSessionHeaders(),
      signal: AbortSignal.timeout(3000)
    });
    if (!resp.ok) return null;
    return await resp.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readPropsFields(props: Record<string, unknown> | null): Record<string, unknown> {
  if (!props) return {};
  const generation = (props.default_generation_settings || {}) as Record<string, unknown>;
  const nCtx = Number(generation.n_ctx ?? props.n_ctx);
  return {
    n_ctx: Number.isFinite(nCtx) && nCtx > 0 ? nCtx : null,
    total_slots: Number(props.total_slots) || null,
    server_model_path: (props.model_path as string) || null,
    build_info: (props.build_info as string) || null,
    modalities: props.modalities ?? null
  };
}

async function clearEmbeddingCacheSafe(): Promise<void> {
  try {
    const embeddingClient = await import('./embedding-client.js');
    if (typeof embeddingClient.clearEmbeddingCache === 'function') {
      embeddingClient.clearEmbeddingCache();
    }
  } catch {
    // ignore cache clear failures
  }
}

// ── LLM server ──

export async function startLlama(config: Record<string, unknown>, win: BrowserWindow | null | undefined): Promise<string> {
  const runtimePath = resolveRuntimeBinary(config.runtime_path as string);
  if (!runtimePath || !fs.existsSync(runtimePath)) {
    throw new Error('llama-server binary not found. Install a runtime first.');
  }
  const resolvedModelPath = resolveModelPath(config.model_path as string);
  if (!resolvedModelPath || !fs.existsSync(resolvedModelPath)) {
    throw new Error(`Model file not found: ${config.model_path}`);
  }

  const launchConfig = resolvedModelPath === config.model_path
    ? config
    : { ...config, model_path: resolvedModelPath };

  // Get system info for runtime config resolution
  const systemInfo = await getHardwareLimits();

  const port = (launchConfig.port as number) || 11435;
  const capabilities = inspectLlamaServer(runtimePath);
  // Per-launch credential so a stray browser tab cannot drive the local model
  // through the server's permissive default CORS policy.
  const apiKey = supportsLlamaFlag(capabilities, '--api-key') ? startLlamaSession(port) : '';
  const args = buildLlamaArgs({ ...launchConfig, api_key: apiKey }, runtimePath, systemInfo, capabilities);

  // Relay everything the supervisor learns — including the load phases it
  // parses out of llama-server's own log — straight to the renderer.
  llama._onStatusChange = (status: Record<string, unknown>) => {
    llamaStatus = { ...llamaStatus, ...status };
    sendSupervisorEvent(win, status);
  };

  emitStatus(win, {
    state: 'starting',
    model_id: path.basename(launchConfig.model_path as string),
    model_path: launchConfig.model_path,
    runtime_path: runtimePath
  });

  try {
    await llama.start({
      binaryPath: runtimePath,
      args,
      healthPort: port,
      statusFields: {
        port,
        model_id: path.basename(launchConfig.model_path as string),
        model_path: launchConfig.model_path,
        runtime_path: runtimePath
      }
    });
    emitStatus(win, {
      state: 'ready',
      port,
      model_id: path.basename(launchConfig.model_path as string),
      model_path: launchConfig.model_path,
      runtime_path: runtimePath,
      ...readPropsFields(await fetchServerProps(port))
    });
    return 'started';
  } catch (err: unknown) {
    endLlamaSession();
    emitStatus(win, { state: 'error', message: toErrorMessage(err) });
    throw err;
  }
}

export async function stopLlama(win: BrowserWindow | null | undefined): Promise<void> {
  await llama.stop({ runtime_path: null, model_path: null, model_id: null, port: null });
  endLlamaSession();
  emitStatus(win, { state: 'idle', runtime_path: null, model_path: null, model_id: null });
}

// ── Embedding server ──

export async function startEmbeddingServer(config: Record<string, unknown>, _win: BrowserWindow | null | undefined): Promise<string> {
  await clearEmbeddingCacheSafe();
  const runtimePath = resolveRuntimeBinary(config.runtime_path as string);
  if (!runtimePath || !fs.existsSync(runtimePath)) {
    throw new Error('llama-server binary not found for embedding server.');
  }
  if (!config.embedding_model_path || !fs.existsSync(config.embedding_model_path as string)) {
    throw new Error(`Embedding model file not found: ${config.embedding_model_path}`);
  }

  // Get system info for runtime config resolution
  const systemInfo = await getHardwareLimits();

  const port = (config.embedding_port as number) || 11436;
  const args = buildEmbeddingArgs(config, systemInfo, runtimePath);

  await embedding.start({
    binaryPath: runtimePath,
    args,
    healthPort: port,
    statusFields: { state: 'starting', port }
  });
  return 'started';
}

export async function stopEmbeddingServer() {
  await embedding.stop({ port: null });
  await clearEmbeddingCacheSafe();
}

export function getEmbeddingStatus() {
  return getEmbeddingStatusState();
}

export function getLlamaStatus() {
  return llamaStatus;
}

// ── Cleanup / status ──

export function cleanupLlm() {
  llama.kill();
  embedding.kill();
  endLlamaSession();
  void clearEmbeddingCacheSafe();
  llamaStatus = { state: 'idle', model_id: null, model_path: null, runtime_path: null, port: null };
  setEmbeddingStatus({ state: 'idle', port: null });
}

export async function getInstalledRuntimes() {
  return { runtimes: listRuntimeBinaries() };
}

export async function deleteRuntimeBinary(binPath: string): Promise<void> {
  if (fs.existsSync(binPath)) {
    const stat = fs.statSync(binPath);
    if (stat.isDirectory()) {
      fs.rmSync(binPath, { recursive: true, force: true });
    } else {
      const versionsRoot = getAppPaths().localBinVersionsRoot;
      const parentDir = path.dirname(binPath);
      if (parentDir.startsWith(versionsRoot)) {
        fs.rmSync(parentDir, { recursive: true, force: true });
      } else {
        fs.rmSync(binPath, { force: true });
      }
    }
  }
  clearRuntimeSelectionFromConfig(binPath);
}

export async function getSupervisorStatus() {
  return {
    state: llamaStatus.state,
    active_model: llamaStatus.model_id || null,
    model_path: llamaStatus.model_path || null,
    runtime_path: llamaStatus.runtime_path || null,
    port: llamaStatus.port || null,
    n_ctx: llamaStatus.n_ctx ?? null,
    total_slots: llamaStatus.total_slots ?? null,
    build_info: llamaStatus.build_info ?? null,
    load_phase: llamaStatus.load_phase ?? null,
    load_progress: llamaStatus.load_progress ?? null,
    log_tail: llamaStatus.log_tail ?? null,
    uptime_secs: null,
    memory_mb: null,
    sessions_count: llama.isRunning() ? 1 : 0
  };
}

/** Minimal Prometheus text-format reader: `name value` per line, `#` comments. */
export function parsePrometheusMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Drop any `{label="..."}` block before splitting off the value.
    const match = trimmed.match(/^([A-Za-z_:][\w:]*)(?:\{[^}]*\})?\s+(-?[\d.eE+]+)$/);
    if (!match) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) out[match[1]] = value;
  }
  return out;
}

async function fetchLocalJson(port: number, path: string): Promise<unknown | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: llamaSessionHeaders(),
      signal: AbortSignal.timeout(3000)
    });
    // --no-slots / missing --metrics answer 501; that is "not available", not a fault.
    if (!resp.ok) return null;
    return path === '/metrics' ? parsePrometheusMetrics(await resp.text()) : await resp.json();
  } catch {
    return null;
  }
}

/**
 * Live measurements from the running server.
 *
 * Slot occupancy comes from /slots (which reports `n_ctx` and `is_processing`
 * per slot, but no token counts or timings), and throughput from the Prometheus
 * gauges on /metrics. Everything here is observed rather than estimated, so a
 * null field means the server did not report it — never a guess.
 */
export async function getRuntimeTelemetry() {
  const port = llamaStatus.port;
  if (!llama.isRunning() || !port) return null;

  const [slotsResult, metricsResult] = await Promise.all([
    fetchLocalJson(port, '/slots'),
    fetchLocalJson(port, '/metrics')
  ]);

  const slots = Array.isArray(slotsResult) ? slotsResult as Record<string, unknown>[] : [];
  const metrics = (metricsResult || {}) as Record<string, number>;

  if (!slots.length && !metricsResult) return null;

  const contextSize = Number(slots[0]?.n_ctx) || Number(llamaStatus.n_ctx) || null;
  // High watermark of context actually observed, which is what a user wants to
  // know about headroom. There is no per-slot token count to read instead.
  const contextUsed = Number.isFinite(metrics['llamacpp:n_tokens_max'])
    ? metrics['llamacpp:n_tokens_max']
    : null;
  const tokensPerSecond = Number.isFinite(metrics['llamacpp:predicted_tokens_seconds'])
    ? metrics['llamacpp:predicted_tokens_seconds']
    : null;

  return {
    context_size: contextSize,
    context_used: contextUsed,
    context_percent: contextSize && contextUsed
      ? Math.min(100, Math.round((contextUsed / contextSize) * 100))
      : null,
    slots_total: slots.length || Number(llamaStatus.total_slots) || 0,
    slots_busy: slots.filter((slot) => slot.is_processing).length,
    tokens_per_second: tokensPerSecond && tokensPerSecond > 0 ? tokensPerSecond : null
  };
}

export async function supervisorHealthCheck(): Promise<boolean> {
  if (!llama.isRunning()) return false;
  try {
    const port = llamaStatus.port || 11435;
    const resp = await fetch(`http://127.0.0.1:${port}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function getLoadedModels() {
  const models = [];
  if (llama.isRunning() && llamaStatus.model_id) {
    models.push({
      id: llamaStatus.model_id,
      model_id: llamaStatus.model_id,
      model_path: llamaStatus.model_path || '',
      port: llamaStatus.port || 11435,
      is_embedding: false
    });
  }
  const embeddingStatus = getEmbeddingStatusState();
  if (embedding.isRunning() && embeddingStatus.port) {
    models.push({
      id: 'embedding-server',
      model_id: 'embedding-server',
      model_path: '',
      port: embeddingStatus.port,
      is_embedding: true
    });
  }
  return models;
}

export async function unloadModel(_modelId: string, win: BrowserWindow | null | undefined): Promise<void> {
  await stopLlama(win);
}

/**
 * The exact command a load would run, without running it.
 *
 * Built through buildLlamaArgs — the same resolver, capability probe and
 * flag gating a real launch takes — so the preview can never drift from
 * reality. Only the API key is withheld.
 */
export async function previewLocalModelCommand(config: Record<string, unknown>): Promise<{ args: string[]; command: string; runtime_path: string }> {
  const runtimePath = resolveRuntimeBinary(String(config.runtime_path || ''));
  if (!runtimePath) {
    throw new Error('llama-server binary not found. Install a runtime first.');
  }
  const resolvedModelPath = resolveModelPath(config.model_path as string);
  if (!resolvedModelPath || !fs.existsSync(resolvedModelPath)) {
    throw new Error(`Model file not found: ${config.model_path}`);
  }

  const launchConfig = resolvedModelPath === config.model_path
    ? config
    : { ...config, model_path: resolvedModelPath };

  const systemInfo = await getHardwareLimits();
  const capabilities = inspectLlamaServer(runtimePath);
  const args = buildLlamaArgs({ ...launchConfig, api_key: '' }, runtimePath, systemInfo, capabilities);

  // Shell-safe quoting for display; the app itself spawns without a shell.
  const quote = (value: string) => (/[^\w@%+=:,./-]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value);
  const command = [runtimePath, ...args.map(quote)].join(' ');

  return { args, command, runtime_path: runtimePath };
}

export async function getRecommendedSettings(
  modelPath: string,
  userContext: unknown,
  userGpuLayers: unknown,
  runtimePath: string
): Promise<Record<string, unknown>> {  const resolvedModelPath = resolveModelPath(modelPath);
  if (!resolvedModelPath || !fs.existsSync(resolvedModelPath)) {
    throw new Error(`Model file not found: ${modelPath}`);
  }

  const hw = await getHardwareLimits();
  const stat = fs.statSync(resolvedModelPath);
  const fileSizeGb = stat.size / (1024 ** 3);
  const vramGb = hw.vram_gb;
  const effectiveRuntimePath = resolveRuntimeBinary(runtimePath);

  const resolved = resolveRuntimeConfig({
    modelPath: resolvedModelPath,
    runtimePath: effectiveRuntimePath,
    userBackend: 'auto',
    userGpuLayers,
    userContextSize: userContext,
    systemInfo: hw
  });

  const ggufFields = readGgufMetadataFields(resolvedModelPath);
  const practicalContextCap = hw.total_ram_gb <= 16 ? 8192 : hw.total_ram_gb <= 32 ? 16384 : 32768;
  let contextLength = Math.min(resolved.contextSize, practicalContextCap);
  let gpuLayers = resolved.gpuLayers;

  if (Number(ggufFields?.block_count || 0) > 0 && gpuLayers > Number(ggufFields.block_count)) {
    gpuLayers = Number(ggufFields.block_count);
  }

  const cpuThreads = Math.max(2, Math.min(hw.physical_cores, hw.cpu_threads - 1));
  const batchSize = gpuLayers > 0 ? 512 : 256;
  const flashAttention = gpuLayers > 0;
  const offloadKv = gpuLayers > 20 && vramGb > fileSizeGb * 1.5;
  const warnings = [];

  if (resolved.contextSize > contextLength) {
    warnings.push(`Context capped to ${contextLength} for system stability (model max is higher).`);
  }

  for (const reason of resolved.reasonLog || []) {
    if (reason.startsWith('context_clamped')) warnings.push(`Context reduced: ${reason}`);
    if (reason.startsWith('gpu_layers=0(file_too_large')) warnings.push('GPU offload disabled because model is larger than available VRAM.');
  }

  return {
    context_length: contextLength,
    gpu_layers: gpuLayers,
    backend: resolved.backend,
    selected_device: resolved.selectedDevice || null,
    available_backends: resolved.availableBackends || [],
    batch_size: batchSize,
    ubatch_size: Math.min(batchSize, 512),
    cpu_threads: cpuThreads,
    flash_attention: flashAttention,
    offload_kv: offloadKv,
    use_mmap: true,
    fit_vram: gpuLayers > 0,
    cache_type_k: gpuLayers > 0 ? 'q8_0' : 'f16',
    cache_type_v: 'f16',
    estimated_memory_gb: Math.round(fileSizeGb * 1.2 * 100) / 100,
    fits_in_vram: fileSizeGb < vramGb * 0.8,
    warnings
  };
}
