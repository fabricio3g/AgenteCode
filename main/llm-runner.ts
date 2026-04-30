import fs from 'node:fs';
import path from 'node:path';
import { getHardwareLimits } from './system-info.ts';
import { ManagedProcess, buildLlamaArgs, buildEmbeddingArgs } from './process-manager.ts';
import {
  resolveRuntimeBinary, listRuntimeBinaries, clearRuntimeSelectionFromConfig
} from './runtime-resolver.ts';
import { getAppPaths } from './paths.ts';
import { resolveRuntimeConfig, readGgufMetadataFields } from './runtime-config-resolver.ts';
import { setEmbeddingStatus, getEmbeddingStatus as getEmbeddingStatusState } from './embedding-state.ts';

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

function isMmprojFileName(fileName) {
  return /(^|[-_.])mmproj[-_.].*\.gguf$/i.test(fileName) || /projector.*\.gguf$/i.test(fileName);
}

function resolveModelPath(inputPath) {
  if (!inputPath) return inputPath;
  if (!fs.existsSync(inputPath)) return inputPath;

  let stat;
  try {
    stat = fs.statSync(inputPath);
  } catch {
    return inputPath;
  }

  if (stat.isFile()) return inputPath;
  if (!stat.isDirectory()) return inputPath;

  const candidates = [];
  const stack = [inputPath];

  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
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

function emitStatus(win, patch) {
  llama.setStatus(patch);
  if (win && !win.isDestroyed()) {
    win.webContents.send('supervisor-event', {
      type: 'state_change',
      from: llamaStatus.state,
      to: patch.state || llamaStatus.state,
      ...patch
    });
  }
}

async function clearEmbeddingCacheSafe() {
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

export async function startLlama(config, win) {
  const runtimePath = resolveRuntimeBinary(config.runtime_path);
  if (!runtimePath || !fs.existsSync(runtimePath)) {
    throw new Error('llama-server binary not found. Install a runtime first.');
  }
  const resolvedModelPath = resolveModelPath(config.model_path);
  if (!resolvedModelPath || !fs.existsSync(resolvedModelPath)) {
    throw new Error(`Model file not found: ${config.model_path}`);
  }

  const launchConfig = resolvedModelPath === config.model_path
    ? config
    : { ...config, model_path: resolvedModelPath };

  // Get system info for runtime config resolution
  const systemInfo = await getHardwareLimits();

  const port = launchConfig.port || 11435;
  const args = buildLlamaArgs(launchConfig, runtimePath, systemInfo);

  // Override the default onStatusChange to emit IPC events
  llama._onStatusChange = (status) => {
    llamaStatus = { ...llamaStatus, ...status };
  };

  emitStatus(win, {
    state: 'starting',
    model_id: path.basename(launchConfig.model_path),
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
        model_id: path.basename(launchConfig.model_path),
        model_path: launchConfig.model_path,
        runtime_path: runtimePath
      }
    });
    emitStatus(win, { state: 'ready', port, model_id: path.basename(launchConfig.model_path), model_path: launchConfig.model_path, runtime_path: runtimePath });
    return 'started';
  } catch (err) {
    emitStatus(win, { state: 'error', message: err.message });
    throw err;
  }
}

export async function stopLlama(win) {
  await llama.stop({ runtime_path: null, model_path: null, model_id: null, port: null });
  emitStatus(win, { state: 'idle', runtime_path: null, model_path: null, model_id: null });
}

// ── Embedding server ──

export async function startEmbeddingServer(config, win) {
  await clearEmbeddingCacheSafe();
  const runtimePath = resolveRuntimeBinary(config.runtime_path);
  if (!runtimePath || !fs.existsSync(runtimePath)) {
    throw new Error('llama-server binary not found for embedding server.');
  }
  if (!config.embedding_model_path || !fs.existsSync(config.embedding_model_path)) {
    throw new Error(`Embedding model file not found: ${config.embedding_model_path}`);
  }

  // Get system info for runtime config resolution
  const systemInfo = await getHardwareLimits();

  const port = config.embedding_port || 11436;
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
  void clearEmbeddingCacheSafe();
  llamaStatus = { state: 'idle', model_id: null, model_path: null, runtime_path: null, port: null };
  embeddingStatus = { state: 'idle', port: null };
}

export async function getInstalledRuntimes() {
  return { runtimes: listRuntimeBinaries() };
}

export async function deleteRuntimeBinary(binPath) {
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
    uptime_secs: null,
    memory_mb: null,
    sessions_count: llama.isRunning() ? 1 : 0
  };
}

export async function supervisorHealthCheck() {
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

export async function unloadModel(_modelId, win) {
  await stopLlama(win);
}

export async function getRecommendedSettings(modelPath, userContext, userGpuLayers, runtimePath) {
  const resolvedModelPath = resolveModelPath(modelPath);
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
