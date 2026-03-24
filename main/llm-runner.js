import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getAppPaths } from './index.js';
import { loadConfig, saveConfig } from './config.js';
import { getHardwareLimits } from './hardware.js';

let llamaProcess = null;
let llamaStatus = { state: 'idle', model_id: null, model_path: null, runtime_path: null, port: null };

function emitStatus(win, status) {
  llamaStatus = { ...llamaStatus, ...status };
  if (win && !win.isDestroyed()) {
    win.webContents.send('supervisor-event', {
      type: 'state_change',
      from: llamaStatus.state,
      to: status.state || llamaStatus.state,
      ...status
    });
  }
}

function inferRuntimeVariant(runtimePath) {
  const value = String(runtimePath || '').toLowerCase();
  if (value.includes('cuda')) return 'cuda';
  if (value.includes('vulkan')) return 'vulkan';
  if (value.includes('rocm') || value.includes('hip')) return 'rocm';
  if (value.includes('sycl')) return 'sycl';
  if (value.includes('cpu')) return 'cpu';
  return 'unknown';
}

function runtimeCandidatesFromDirectory(dirPath) {
  const candidates = ['llama-server', 'llama-server.exe', 'server'];
  return candidates.map((bin) => path.join(dirPath, bin)).filter((candidate) => fs.existsSync(candidate));
}

function resolveRuntimeCandidate(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return null;
  const stat = fs.statSync(candidate);
  if (stat.isDirectory()) {
    return runtimeCandidatesFromDirectory(candidate)[0] || null;
  }
  return candidate;
}

function listRuntimeBinaries() {
  const paths = getAppPaths();
  const cfg = loadConfig();
  const activeRuntimePath = cfg.llm?.local?.runtime_path || cfg.llm?.local?.binary?.path || '';
  const resolvedActiveRuntimePath = resolveRuntimeCandidate(activeRuntimePath) || activeRuntimePath;
  const activeRuntimeId = cfg.llm?.local?.binary?.active_runtime_id || '';
  const runtimes = [];
  const versionsDir = paths.localBinVersionsRoot;

  if (fs.existsSync(versionsDir)) {
    const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(versionsDir, entry.name);
      for (const binPath of runtimeCandidatesFromDirectory(dirPath)) {
        const stat = fs.statSync(binPath);
        const selected = resolvedActiveRuntimePath ? resolvedActiveRuntimePath === binPath : activeRuntimeId ? activeRuntimeId === entry.name : false;
        runtimes.push({
          id: entry.name,
          name: entry.name,
          path: binPath,
          variant: inferRuntimeVariant(entry.name || binPath),
          size_gb: Math.round((stat.size / (1024 ** 3)) * 100) / 100,
          modified: stat.mtimeMs,
          is_active: selected
        });
        break;
      }
    }
  }

  const directBin = path.join(paths.localBinRoot, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  if (fs.existsSync(directBin)) {
    const stat = fs.statSync(directBin);
    runtimes.push({
      id: 'default',
      name: 'default',
      path: directBin,
      variant: inferRuntimeVariant(directBin),
      size_gb: Math.round((stat.size / (1024 ** 3)) * 100) / 100,
      modified: stat.mtimeMs,
      is_active: resolvedActiveRuntimePath ? resolvedActiveRuntimePath === directBin : false
    });
  }

  return runtimes.sort((left, right) => {
    if (!!right.is_active !== !!left.is_active) return Number(!!right.is_active) - Number(!!left.is_active);
    if ((right.modified || 0) !== (left.modified || 0)) return (right.modified || 0) - (left.modified || 0);
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
}

function resolveRuntimeBinary(explicitPath = '') {
  const cfg = loadConfig();
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (cfg.llm?.local?.runtime_path) candidates.push(cfg.llm.local.runtime_path);
  if (cfg.llm?.local?.binary?.path) candidates.push(cfg.llm.local.binary.path);

  for (const runtime of listRuntimeBinaries()) {
    candidates.push(runtime.path);
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const resolved = resolveRuntimeCandidate(candidate);
    if (resolved) return resolved;
  }

  return null;
}

function clearRuntimeSelectionFromConfig(binPath) {
  const cfg = loadConfig();
  const next = structuredClone(cfg);
  let dirty = false;
  const resolvedSelection = resolveRuntimeCandidate(next.llm?.local?.runtime_path || next.llm?.local?.binary?.path || '');
  if (resolvedSelection && resolvedSelection === binPath) {
    next.llm.local.runtime_path = '';
    dirty = true;
  }
  if (next.llm?.local?.binary?.path && resolveRuntimeCandidate(next.llm.local.binary.path) === binPath) {
    next.llm.local.binary.path = '';
    dirty = true;
  }
  if (next.llm?.local?.binary?.active_runtime_id && next.llm.local.binary.path === '') {
    next.llm.local.binary.active_runtime_id = '';
    dirty = true;
  }
  if (dirty) saveConfig(next);
}

export async function startLlama(config, win) {
  if (llamaProcess) {
    await stopLlama(win);
  }

  const runtimePath = resolveRuntimeBinary(config.runtime_path);
  if (!runtimePath || !fs.existsSync(runtimePath)) {
    throw new Error('llama-server binary not found. Install a runtime first.');
  }

  if (!config.model_path || !fs.existsSync(config.model_path)) {
    throw new Error(`Model file not found: ${config.model_path}`);
  }

  const args = [
    '--model', config.model_path,
    '--host', config.host || '127.0.0.1',
    '--port', String(config.port || 11435),
    '--ctx-size', String(config.context_length || 4096),
    '--n-gpu-layers', String(config.gpu_offload || 0),
    '--threads', String(config.cpu_threads || Math.max(1, os.cpus().length - 1)),
    '--batch-size', String(config.batch_size || 512)
  ];

  if (config.flash_attention) args.push('--flash-attn');
  if (config.mmap === false) args.push('--no-mmap');
  if (config.keep_in_memory) args.push('--mlock');
  if (config.seed != null) args.push('--seed', String(config.seed));
  if (config.parallel) args.push('--parallel', String(config.parallel));
  if (config.rope_freq_base) args.push('--rope-freq-base', String(config.rope_freq_base));
  if (config.rope_freq_scale) args.push('--rope-freq-scale', String(config.rope_freq_scale));
  if (config.cache_type_k) args.push('--cache-type-k', config.cache_type_k);
  if (config.cache_type_v) args.push('--cache-type-v', config.cache_type_v);
  if (config.mmproj_path) args.push('--mmproj', config.mmproj_path);

  emitStatus(win, {
    state: 'starting',
    model_id: path.basename(config.model_path),
    model_path: config.model_path,
    runtime_path: runtimePath
  });

  return new Promise((resolve, reject) => {
    try {
      llamaProcess = spawn(runtimePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
      });
    } catch (err) {
      emitStatus(win, { state: 'error', message: err.message });
      reject(err);
      return;
    }

    let resolved = false;
    const startupTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const port = config.port || 11435;
        const healthCheckInterval = setInterval(async () => {
          try {
            const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
            if (resp.ok) {
              clearInterval(healthCheckInterval);
              emitStatus(win, {
                state: 'ready',
                port,
                model_id: path.basename(config.model_path),
                model_path: config.model_path,
                runtime_path: runtimePath
              });
              resolve('started');
            }
          } catch {
            // Server not ready yet, continue checking
          }
        }, 1000);
        setTimeout(() => {
          clearInterval(healthCheckInterval);
          if (!resolved) {
            resolved = true;
            emitStatus(win, {
              state: 'ready',
              port,
              model_id: path.basename(config.model_path),
              model_path: config.model_path,
              runtime_path: runtimePath
            });
            resolve('started');
          }
        }, 20000);
      }
    }, 30000);

    llamaProcess.stdout.on('data', (data) => {
      const line = data.toString();
      if (!resolved && (
        line.includes('server is listening') ||
        line.includes('HTTP server listening') ||
        line.includes('listening at')
      )) {
        resolved = true;
        clearTimeout(startupTimeout);
        emitStatus(win, {
          state: 'ready',
          port: config.port || 11435,
          model_id: path.basename(config.model_path),
          model_path: config.model_path,
          runtime_path: runtimePath
        });
        resolve('started');
      }
    });

    llamaProcess.stderr.on('data', (data) => {
      const line = data.toString();
      if (!resolved && (
        line.includes('server is listening') ||
        line.includes('HTTP server listening') ||
        line.includes('listening at')
      )) {
        resolved = true;
        clearTimeout(startupTimeout);
        emitStatus(win, {
          state: 'ready',
          port: config.port || 11435,
          model_id: path.basename(config.model_path),
          model_path: config.model_path,
          runtime_path: runtimePath
        });
        resolve('started');
      }
    });

    llamaProcess.on('error', (err) => {
      clearTimeout(startupTimeout);
      emitStatus(win, { state: 'error', message: err.message });
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    llamaProcess.on('exit', (code, signal) => {
      clearTimeout(startupTimeout);
      llamaProcess = null;
      emitStatus(win, { state: 'idle', runtime_path: null, model_path: null, model_id: null });
      if (!resolved) {
        resolved = true;
        if (code !== 0) {
          reject(new Error(`llama-server exited with code ${code}, signal ${signal}`));
        } else {
          resolve('exited');
        }
      }
    });
  });
}

export async function stopLlama(win) {
  if (llamaProcess) {
    emitStatus(win, { state: 'stopping' });
    llamaProcess.kill('SIGTERM');
    await new Promise(resolve => {
      const t = setTimeout(() => {
        if (llamaProcess) llamaProcess.kill('SIGKILL');
        resolve();
      }, 5000);
      if (llamaProcess) {
        llamaProcess.on('exit', () => { clearTimeout(t); resolve(); });
      } else {
        clearTimeout(t);
        resolve();
      }
    });
    llamaProcess = null;
    emitStatus(win, { state: 'idle', runtime_path: null, model_path: null, model_id: null });
  }
}

export function getLlamaStatus() {
  return llamaStatus;
}

export function cleanupLlm() {
  if (llamaProcess) {
    llamaProcess.kill('SIGKILL');
    llamaProcess = null;
  }
  llamaStatus = { state: 'idle', model_id: null, model_path: null, runtime_path: null, port: null };
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
    sessions_count: llamaProcess ? 1 : 0
  };
}

export async function supervisorHealthCheck() {
  if (!llamaProcess) return false;
  try {
    const port = llamaStatus.port || 11435;
    const resp = await fetch(`http://127.0.0.1:${port}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function getLoadedModels() {
  if (!llamaProcess || !llamaStatus.model_id) return [];
  return [{
    id: llamaStatus.model_id,
    model_id: llamaStatus.model_id,
    model_path: llamaStatus.model_path || '',
    port: llamaStatus.port || 11435,
    is_embedding: false
  }];
}

export async function unloadModel(_modelId, win) {
  await stopLlama(win);
}

export async function getRecommendedSettings(modelPath, userContext, userGpuLayers) {
  const hw = await getHardwareLimits();
  const stat = fs.statSync(modelPath);
  const fileSizeGb = stat.size / (1024 ** 3);

  const totalRamGb = hw.total_ram_gb;
  const vramGb = hw.vram_gb;

  // Estimate parameters from file size
  const bitsPerParam = 4.5; // rough average for Q4 quant
  const paramCount = (stat.size * 8) / bitsPerParam / 1e9;

  // Context length estimation
  let contextLength = userContext || 4096;
  if (fileSizeGb > 10) contextLength = Math.min(contextLength, 8192);
  if (fileSizeGb > 20) contextLength = Math.min(contextLength, 4096);

  // GPU layers
  let gpuLayers = userGpuLayers ?? 0;
  if (userGpuLayers == null && vramGb > 0) {
    if (fileSizeGb < vramGb * 0.8) gpuLayers = 999; // full offload
    else if (fileSizeGb < vramGb * 1.2) gpuLayers = Math.floor(32 * (vramGb / fileSizeGb));
    else gpuLayers = 0;
  }

  const cpuThreads = Math.max(2, Math.min(hw.physical_cores, hw.cpu_threads - 1));
  const batchSize = gpuLayers > 0 ? 512 : 256;
  const flashAttention = gpuLayers > 0;
  const offloadKv = gpuLayers > 20 && vramGb > fileSizeGb * 1.5;

  return {
    context_length: contextLength,
    gpu_layers: gpuLayers,
    batch_size: batchSize,
    ubatch_size: Math.min(batchSize, 512),
    cpu_threads: cpuThreads,
    flash_attention: flashAttention,
    offload_kv: offloadKv,
    use_mmap: true,
    estimated_memory_gb: Math.round(fileSizeGb * 1.2 * 100) / 100,
    fits_in_vram: fileSizeGb < vramGb * 0.8,
    warnings: []
  };
}
