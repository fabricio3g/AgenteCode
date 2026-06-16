import { spawn } from 'node:child_process';
import os from 'node:os';
import { resolveRuntimeConfig, formatStartupLog } from './runtime-config-resolver.ts';

const READY_PATTERNS = ['server is listening', 'HTTP server listening', 'listening at'];
const DEFAULT_STARTUP_TIMEOUT = 30000;
const DEFAULT_HEALTH_TIMEOUT = 20000;
const GRACEFUL_SHUTDOWN_MS = 5000;
const HEALTH_CHECK_INTERVAL = 1000;

function lineMatchesReady(line) {
  return READY_PATTERNS.some(p => line.includes(p));
}

export class ManagedProcess {
  constructor(options = {}) {
    this.process = null;
    this.status = { state: 'idle', ...options.initialStatus };
    this._onStatusChange = options.onStatusChange || (() => {});
    this._stdoutListener = null;
    this._stderrListener = null;
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this._onStatusChange(this.status);
  }

  async start({ binaryPath, args, env, healthPort, statusFields = {} }) {
    if (this.process) {
      await this.stop();
    }

    this.setStatus({ state: 'starting', ...statusFields });

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(binaryPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...env }
        });
      } catch (err) {
        this.setStatus({ state: 'error', message: err.message });
        reject(err);
        return;
      }

      let resolved = false;
      let recentLogs = [];

      const startupTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this._beginHealthPolling(healthPort, resolved, resolve, statusFields, DEFAULT_HEALTH_TIMEOUT);
        }
      }, DEFAULT_STARTUP_TIMEOUT);

      const onData = (data) => {
        const text = String(data || '');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          recentLogs.push(trimmed);
          if (recentLogs.length > 80) recentLogs.shift();
        }

        if (!resolved && lineMatchesReady(text)) {
          resolved = true;
          clearTimeout(startupTimeout);
          this.setStatus({ state: 'ready', ...statusFields });
          resolve('started');
        }
      };

      this._stdoutListener = onData;
      this._stderrListener = onData;
      this.process.stdout.on('data', onData);
      this.process.stderr.on('data', onData);

      this.process.on('error', (err) => {
        clearTimeout(startupTimeout);
        this.setStatus({ state: 'error', message: err.message });
        if (!resolved) { resolved = true; reject(err); }
      });

      this.process.on('exit', (code, signal) => {
        clearTimeout(startupTimeout);
        this.process = null;
        if (!resolved) {
          resolved = true;
          if (code !== 0) {
            const tail = recentLogs.slice(-20).join('\n');
            reject(new Error(`Process exited with code ${code}, signal ${signal}${tail ? `\n${tail}` : ''}`));
          } else {
            resolve('exited');
          }
        }
      });
    });
  }

  _beginHealthPolling(port, resolvedFlag, resolve, statusFields, timeoutMs) {
    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (resp.ok) {
          clearInterval(interval);
          clearTimeout(fallbackTimer);
          this.setStatus({ state: 'ready', ...statusFields });
          resolve('started');
        }
      } catch { /* not ready */ }
    }, HEALTH_CHECK_INTERVAL);

    const fallbackTimer = setTimeout(() => {
      clearInterval(interval);
      this.setStatus({ state: 'ready', ...statusFields });
      resolve('started');
    }, timeoutMs);
  }

  async stop(idleFields = {}) {
    if (!this.process) return;
    const proc = this.process;
    // Remove stored listeners before killing
    if (this._stdoutListener) {
      proc.stdout.off('data', this._stdoutListener);
      this._stdoutListener = null;
    }
    if (this._stderrListener) {
      proc.stderr.off('data', this._stderrListener);
      this._stderrListener = null;
    }
    this.setStatus({ state: 'stopping' });
    proc.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, GRACEFUL_SHUTDOWN_MS);
      proc.on('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.process = null;
    this.setStatus({ state: 'idle', ...idleFields });
  }

  kill() {
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
  }

  isRunning() {
    return this.process !== null;
  }
}

// ── Argument builders ──

export function buildLlamaArgs(config, runtimePath, systemInfo = null) {
  // Resolve runtime configuration with backend detection and context guardrails
  const resolved = resolveRuntimeConfig({
    modelPath: config.model_path,
    runtimePath,
    userBackend: config.backend_mode,
    userGpuLayers: config.gpu_offload,
    userContextSize: config.context_length,
    batchSize: config.batch_size,
    ubatchSize: config.ubatch_size,
    tensorSplit: config.tensor_split,
    mainGpu: config.main_gpu,
    systemInfo
  });

  const isGpu = resolved.gpuLayers > 0;
  const threads = config.cpu_threads || Math.max(1, os.cpus().length - 1);

  const args = [
    '--model', config.model_path,
    '--host', config.host || '127.0.0.1',
    '--port', String(config.port || 11435),
    '--ctx-size', String(resolved.contextSize),
    '--n-gpu-layers', String(resolved.gpuLayers),
    '--threads', String(threads),
    '--batch-size', String(resolved.batchSize)
  ];

  if (isGpu && resolved.selectedDevice) {
    args.push('--device', resolved.selectedDevice);
  }

  if (config.fit_vram !== false && isGpu) args.push('--fit', 'on');
  if (config.sleep_idle_seconds != null && isGpu) args.push('--sleep-idle-seconds', String(config.sleep_idle_seconds));
  args.push('--flash-attn', config.flash_attention === false ? 'off' : 'auto');
  args.push('--no-webui');
  args.push('--ubatch-size', String(resolved.ubatchSize));

  const defaultCacheK = isGpu ? 'q8_0' : 'f16';
  const defaultCacheV = 'f16';
  const cacheTypeK = config.cache_type_k || defaultCacheK;
  let cacheTypeV = config.cache_type_v || defaultCacheV;
  if (resolved.backend === 'vulkan' && /^q/i.test(String(cacheTypeV || ''))) {
    cacheTypeV = 'f16';
  }
  args.push('--cache-type-k', cacheTypeK);
  args.push('--cache-type-v', cacheTypeV);

  // Multi-GPU support
  if (resolved.tensorSplit && Array.isArray(resolved.tensorSplit) && resolved.tensorSplit.length > 0) {
    args.push('--tensor-split', resolved.tensorSplit.join(','));
  }
  if (resolved.mainGpu != null && resolved.mainGpu >= 0) {
    args.push('--main-gpu', String(resolved.mainGpu));
  }

  if (config.speculative_decoding) {
    args.push('--spec-type', 'ngram-cache');
    if (config.speculative_ngram != null) args.push('--ngram-cache-size', String(config.speculative_ngram));
  }

  if (config.mmap === false) args.push('--no-mmap');
  if (config.keep_in_memory) args.push('--mlock');
  if (config.seed != null) args.push('--seed', String(config.seed));
  if (config.parallel) args.push('--parallel', String(config.parallel));
  if (config.rope_freq_base) args.push('--rope-freq-base', String(config.rope_freq_base));
  if (config.rope_freq_scale) args.push('--rope-freq-scale', String(config.rope_freq_scale));
  if (config.mmproj_path) args.push('--mmproj', config.mmproj_path);
  if (config.disable_thinking) args.push('--reasoning', 'off');

  if (config.mtp) {
    const draftPath = String(config.mtp_draft_path || '').trim();
    const draftNMax = Number.isFinite(Number(config.mtp_draft_n_max))
      ? Math.max(1, Math.min(16, Math.floor(Number(config.mtp_draft_n_max))))
      : (draftPath ? 4 : 2);
    if (draftPath) {
      args.push('--model-draft', draftPath);
      args.push('--spec-type', 'draft-mtp');
      args.push('--spec-draft-n-max', String(draftNMax));
    } else {
      args.push('--spec-type', 'draft-mtp');
      args.push('--spec-draft-n-max', String(draftNMax));
    }
  }

  // Log resolved configuration for debugging
  console.log(formatStartupLog(resolved));

  return args;
}

export function buildEmbeddingArgs(config, systemInfo = null, runtimePath = null) {
  const port = config.embedding_port || 11436;
  const threads = Math.max(1, Math.floor(os.cpus().length / 2));

  // Resolve embedding GPU layers with same logic
  const resolved = resolveRuntimeConfig({
    modelPath: config.embedding_model_path,
    runtimePath,
    userBackend: config.backend_mode,
    userGpuLayers: config.embedding_gpu_layers,
    userContextSize: config.embedding_context_length,
    systemInfo
  });

  const args = [
    '--model', config.embedding_model_path,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--embedding',
    '--pooling', 'mean',
    '--ctx-size', String(resolved.contextSize),
    '--n-gpu-layers', String(resolved.gpuLayers),
    '--threads', String(threads),
    '--batch-size', '256',
    '--ubatch-size', '256',
    '--no-webui'
  ];

  if (resolved.gpuLayers > 0 && resolved.selectedDevice) {
    args.push('--device', resolved.selectedDevice);
  }

  return args;
}
