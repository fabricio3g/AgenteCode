import { spawn } from 'node:child_process';
import os from 'node:os';
import { resolveRuntimeConfig, formatStartupLog } from './runtime-config-resolver.ts';
import { supportsLlamaFlag } from './llama-runtime.ts';

const DEFAULT_STARTUP_TIMEOUT = 30000;
const DEFAULT_HEALTH_TIMEOUT = 20000;
const GRACEFUL_SHUTDOWN_MS = 5000;
const HEALTH_CHECK_INTERVAL = 1000;

/**
 * Startup stages recognised from llama-server's own log output, in the order
 * it reaches them. The progress numbers are checkpoints tied to real events
 * rather than a timer, so the bar only moves when the server actually moved.
 */
const LOAD_PHASES = [
  { id: 'reading_metadata', label: 'Reading model metadata', progress: 15, match: /llama_model_loader:|^load: /i },
  { id: 'loading_weights', label: 'Loading weights', progress: 45, match: /load_tensors:/i },
  { id: 'allocating_cache', label: 'Allocating KV cache', progress: 70, match: /llama_kv_cache|KV self size|llama_context:/i },
  { id: 'warming_up', label: 'Warming up', progress: 88, match: /warming up|warmup/i },
  { id: 'starting_server', label: 'Starting server', progress: 95, match: /model loaded|server is listening|starting the main loop/i }
];

function matchLoadPhase(line) {
  for (let i = LOAD_PHASES.length - 1; i >= 0; i--) {
    if (LOAD_PHASES[i].match.test(line)) return i;
  }
  return -1;
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

      let settled = false;
      let recentLogs = [];
      let phaseIndex = -1;

      const startupTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.process?.kill('SIGTERM');
        const tail = recentLogs.slice(-20).join('\n');
        const reached = phaseIndex >= 0 ? ` while ${LOAD_PHASES[phaseIndex].label.toLowerCase()}` : '';
        const message = `Server health check timed out${reached}${tail ? `\n${tail}` : ''}`;
        this.setStatus({ state: 'error', message, log_tail: recentLogs.slice(-20) });
        reject(new Error(message));
      }, DEFAULT_STARTUP_TIMEOUT + DEFAULT_HEALTH_TIMEOUT);

      const healthInterval = setInterval(async () => {
        if (settled) return;
        try {
          const resp = await fetch(`http://127.0.0.1:${healthPort}/health`, { signal: AbortSignal.timeout(2000) });
          if (!resp.ok) return;
          settled = true;
          clearTimeout(startupTimeout);
          clearInterval(healthInterval);
          this.setStatus({ state: 'ready', load_progress: 100, load_phase: null, log_tail: null, ...statusFields });
          resolve('started');
        } catch {
          // The server commonly needs several seconds to load a model.
        }
      }, HEALTH_CHECK_INTERVAL);

      const onData = (data) => {
        const text = String(data || '');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          recentLogs.push(trimmed);
          if (recentLogs.length > 80) recentLogs.shift();

          // Report load progress from what the server says it is doing. Phases
          // only ever advance — a later log line about an earlier stage must
          // not walk the bar backwards.
          if (settled) continue;
          const matched = matchLoadPhase(trimmed);
          if (matched > phaseIndex) {
            phaseIndex = matched;
            const phase = LOAD_PHASES[matched];
            this.setStatus({ load_phase: phase.label, load_phase_id: phase.id, load_progress: phase.progress });
          }
        }

        // Keep logs for actionable startup errors. Readiness is determined by
        // the HTTP health endpoint, not a version-specific log line.
      };

      this._stdoutListener = onData;
      this._stderrListener = onData;
      this.process.stdout.on('data', onData);
      this.process.stderr.on('data', onData);

        this.process.on('error', (err) => {
          clearTimeout(startupTimeout);
          clearInterval(healthInterval);
          this.setStatus({ state: 'error', message: err.message });
          if (!settled) { settled = true; reject(err); }
        });

      this.process.on('exit', (code, signal) => {
          clearTimeout(startupTimeout);
          clearInterval(healthInterval);
          this.process = null;
          if (!settled) {
            settled = true;
          if (code !== 0) {
            const tail = recentLogs.slice(-20).join('\n');
            this.setStatus({ log_tail: recentLogs.slice(-20) });
            reject(new Error(`Process exited with code ${code}, signal ${signal}${tail ? `\n${tail}` : ''}`));
          } else {
            resolve('exited');
          }
        }
      });
    });
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

export function buildLlamaArgs(config, runtimePath, systemInfo = null, capabilities = null) {
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
  const supports = (flag) => supportsLlamaFlag(capabilities, flag);

  const args = [
    '--model', config.model_path,
    '--host', config.host || '127.0.0.1',
    '--port', String(config.port || 11435)
  ];

  // Sizing: llama.cpp defaults to `-ngl auto`, `-c 0` and `--fit on`, which
  // measures real device memory. Our own estimates only win when the user made
  // an explicit choice, so anything they left on auto is left off the command
  // line entirely.
  if (resolved.contextSource === 'user') args.push('--ctx-size', String(resolved.contextSize));
  if (resolved.gpuLayersSource === 'user') {
    args.push('--n-gpu-layers', String(resolved.gpuLayers));
  } else if (resolved.backend === 'cpu') {
    // No usable GPU backend in this build, or the user asked for CPU — say so
    // rather than letting auto-fit offload anyway.
    args.push('--n-gpu-layers', '0');
  }
  if (resolved.batchSource === 'user') args.push('--batch-size', String(resolved.batchSize));
  if (resolved.ubatchSource === 'user') args.push('--ubatch-size', String(resolved.ubatchSize));
  if (config.cpu_threads) args.push('--threads', String(config.cpu_threads));

  if (resolved.backend !== 'cpu' && resolved.selectedDevice) {
    args.push('--device', resolved.selectedDevice);
  }

  if (supports('--fit')) args.push('--fit', config.fit_vram === false ? 'off' : 'on');
  if (config.sleep_idle_seconds != null && supports('--sleep-idle-seconds')) {
    args.push('--sleep-idle-seconds', String(config.sleep_idle_seconds));
  }
  if (supports('--flash-attn')) args.push('--flash-attn', config.flash_attention === false ? 'off' : 'auto');
  if (supports('--no-webui')) args.push('--no-webui');

  const defaultCacheK = isGpu ? 'q8_0' : 'f16';
  const defaultCacheV = 'f16';
  const cacheTypeK = config.cache_type_k || defaultCacheK;
  let cacheTypeV = config.cache_type_v || defaultCacheV;
  if (resolved.backend === 'vulkan' && /^q/i.test(String(cacheTypeV || ''))) {
    cacheTypeV = 'f16';
  }
  args.push('--cache-type-k', cacheTypeK);
  args.push('--cache-type-v', cacheTypeV);

  // KV cache offload is on by default upstream; only the opt-out needs saying.
  if (config.offload_kv_cache === false && supports('--no-kv-offload')) args.push('--no-kv-offload');

  // Sliding-window models (Gemma-class) need the full cache for prompt reuse.
  if (config.swa_full && supports('--swa-full')) args.push('--swa-full');

  // Context shift now defaults to off: without it a long chat hard-errors
  // instead of dropping its oldest turns.
  if (config.context_shift && supports('--context-shift')) args.push('--context-shift');

  // Prompt cache shared across conversations, and KV reuse within one.
  if (Number(config.cache_ram_mb) >= 0 && config.cache_ram_mb != null && supports('--cache-ram')) {
    args.push('--cache-ram', String(Math.floor(Number(config.cache_ram_mb))));
  }
  if (Number(config.cache_reuse) > 0 && supports('--cache-reuse')) {
    args.push('--cache-reuse', String(Math.floor(Number(config.cache_reuse))));
  }

  // MoE expert offload — the difference between a 30B MoE running and not
  // running on a mid-range GPU. `--n-cpu-moe N` is the partial form of
  // `--cpu-moe`, so the two are mutually exclusive.
  if (Number(config.n_cpu_moe) > 0 && supports('--n-cpu-moe')) {
    args.push('--n-cpu-moe', String(Math.floor(Number(config.n_cpu_moe))));
  } else if (config.cpu_moe && supports('--cpu-moe')) {
    args.push('--cpu-moe');
  }

  // Multi-GPU support
  if (resolved.tensorSplit && Array.isArray(resolved.tensorSplit) && resolved.tensorSplit.length > 0) {
    args.push('--tensor-split', resolved.tensorSplit.join(','));
  }
  if (resolved.mainGpu != null && resolved.mainGpu >= 0) {
    args.push('--main-gpu', String(resolved.mainGpu));
  }
  if (config.split_mode && supports('--split-mode')) args.push('--split-mode', String(config.split_mode));

  if (config.speculative_decoding && supports('--spec-type')) {
    args.push('--spec-type', 'ngram-cache');
  }

  // `--load-mode` replaced the deprecated `--mlock` / `--no-mmap` pair.
  // Passing bare `mlock` turns mmap off, which is not what "keep in memory"
  // means when the user also has memory-mapping enabled.
  const wantsMmap = config.mmap !== false;
  const wantsLock = !!config.keep_in_memory;
  if (supports('--load-mode')) {
    const loadMode = wantsLock
      ? (wantsMmap ? 'mmap+mlock' : 'mlock')
      : (wantsMmap ? 'mmap' : 'none');
    args.push('--load-mode', loadMode);
  } else {
    if (!wantsMmap && supports('--no-mmap')) args.push('--no-mmap');
    if (wantsLock && supports('--mlock')) args.push('--mlock');
  }

  if (config.seed != null) args.push('--seed', String(config.seed));
  // Upstream's `auto` picks the slot count and enables a unified KV buffer;
  // pinning it to 1 gives up both for nothing.
  if (Number(config.parallel) > 1) args.push('--parallel', String(Math.floor(Number(config.parallel))));
  if (config.rope_freq_base) args.push('--rope-freq-base', String(config.rope_freq_base));
  if (config.rope_freq_scale) args.push('--rope-freq-scale', String(config.rope_freq_scale));
  if (config.mmproj_path) args.push('--mmproj', config.mmproj_path);
  const thinkingMode = config.thinking_mode || (config.disable_thinking ? 'off' : 'auto');
  if (thinkingMode === 'off' && supports('--reasoning')) args.push('--reasoning', 'off');
  else if (thinkingMode === 'on' && supports('--reasoning')) args.push('--reasoning', 'on');

  // Tool calling requires Jinja template rendering server-side (current builds
  // default it on, but older runtimes need the explicit flag — every upstream
  // function-calling sample passes it). Without it the server throws
  // "tools param requires --jinja flag" on any request carrying tools.
  if (supports('--jinja')) args.push('--jinja');

  // Enables GET /metrics for the runtime telemetry panel. `--props` is
  // deliberately not passed: GET /props needs no flag, and the flag only opens
  // up POST /props, which would let anything on the box mutate server state.
  if (supports('--metrics')) args.push('--metrics');

  if (config.api_key && supports('--api-key')) args.push('--api-key', String(config.api_key));

  if (config.mtp && supportsLlamaFlag(capabilities, '--spec-type')) {
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

  // Pooling is deliberately not forced: `mean` is wrong for CLS-pooled
  // encoders, and llama.cpp reads the correct type from the GGUF itself.
  const args = [
    '--model', config.embedding_model_path,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--embedding',
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
