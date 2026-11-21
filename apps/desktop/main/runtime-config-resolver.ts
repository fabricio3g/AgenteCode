import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRuntimeBinary } from './runtime-resolver.ts';
import { listDevices } from './runtime-devices.ts';
import { createLogger } from './utils/logger.ts';
import { detectTemplateThinkingSupport, detectTemplateToolSupport } from './chat-templates.ts';

// ── Constants ──

const BACKENDS = ['auto', 'cpu', 'cuda', 'vulkan', 'rocm', 'hip', 'metal', 'opencl', 'openvino', 'sycl', 'webgpu'];
const DEFAULT_CONTEXT_FALLBACK = 4096;
const CONTEXT_DOWNSCALE_STEP = 0.5;
const MIN_CONTEXT_SIZE = 512;
const GGUF_FIELDS_CACHE = new Map();
const GGUF_FIELDS_CACHE_MAX = 500;

const log = createLogger('[runtime-config]');

// ── GGUF Metadata Reader ──

const GGUF_MAGIC = 0x46554747;

function readLengthWithFallback(buf, offset) {
  if (offset + 8 <= buf.length) {
    const len64 = Number(buf_readBigUInt64LE_safe(buf, offset));
    if (Number.isFinite(len64) && len64 >= 0 && len64 <= (buf.length - offset - 8)) {
      return { length: len64, size: 8 };
    }
  }

  if (offset + 4 <= buf.length) {
    const len32 = buf.readUInt32LE(offset);
    if (Number.isFinite(len32) && len32 >= 0 && len32 <= (buf.length - offset - 4)) {
      return { length: len32, size: 4 };
    }
  }

  return null;
}

function readGgufNumber(buf, type, offset) {
  switch (type) {
    case 0: return { value: buf.readUInt8(offset), size: 1 };
    case 1: return { value: buf.readInt8(offset), size: 1 };
    case 2: return { value: buf.readUInt16LE(offset), size: 2 };
    case 3: return { value: buf.readInt16LE(offset), size: 2 };
    case 4: return { value: buf.readUInt32LE(offset), size: 4 };
    case 5: return { value: buf.readInt32LE(offset), size: 4 };
    case 6: return { value: buf.readFloatLE(offset), size: 4 };
    case 7: return { value: buf.readUInt8(offset) !== 0, size: 1 };
    case 10: return { value: Number(buf.readBigUInt64LE(offset)), size: 8 };
    case 11: return { value: Number(buf.readBigInt64LE(offset)), size: 8 };
    case 12: return { value: buf.readDoubleLE(offset), size: 8 };
    default: return { value: 0, size: 0 };
  }
}

function readGgufString(buf, offset) {
  const length = readLengthWithFallback(buf, offset);
  if (!length) return { value: '', size: 0 };
  const start = offset + length.size;
  const end = start + length.length;
  if (end > buf.length) return { value: '', size: 0 };
  const str = buf.toString('utf8', start, end);
  return { value: str, size: length.size + length.length };
}

function isFinitePositiveInt(value) {
  return Number.isFinite(value) && value > 0;
}

function readGgufArray(buf, offset) {
  if (offset + 8 > buf.length) return { value: [], size: 0 };

  const arrType = buf.readUInt32LE(offset);
  const arrLenParsed = readLengthWithFallback(buf, offset + 4);
  if (!arrLenParsed) return { value: [], size: 0 };
  const arrLen = arrLenParsed.length;
  let cursor = offset + 4 + arrLenParsed.size;

  if (!Number.isFinite(arrLen) || arrLen < 0) return { value: [], size: 0 };

  // To avoid expensive parsing (e.g. tokenizer token arrays), only decode
  // small arrays that we actually might use.
  if (arrLen > 512) {
    if (arrType === 8) {
      // string array: need to walk lengths to skip safely
      for (let i = 0; i < arrLen; i++) {
        const lenParsed = readLengthWithFallback(buf, cursor);
        if (!lenParsed) return { value: [], size: 0 };
        cursor += lenParsed.size + Math.max(0, lenParsed.length);
        if (cursor > buf.length) return { value: [], size: 0 };
      }
      return { value: [], size: cursor - offset };
    }

    const { size: elemSize } = readGgufNumber(buf, arrType, cursor);
    if (!elemSize) return { value: [], size: 0 };
    cursor += elemSize * arrLen;
    if (cursor > buf.length) return { value: [], size: 0 };
    return { value: [], size: cursor - offset };
  }

  const values = [];
  for (let i = 0; i < arrLen; i++) {
    if (cursor >= buf.length) return { value: [], size: 0 };
    if (arrType === 8) {
      const parsed = readGgufString(buf, cursor);
      values.push(parsed.value);
      cursor += parsed.size;
      continue;
    }
    if (arrType === 9) {
      const parsed = readGgufArray(buf, cursor);
      if (!parsed.size) return { value: [], size: 0 };
      values.push(parsed.value);
      cursor += parsed.size;
      continue;
    }
    const parsed = readGgufNumber(buf, arrType, cursor);
    if (!parsed.size) return { value: [], size: 0 };
    values.push(parsed.value);
    cursor += parsed.size;
  }

  return { value: values, size: cursor - offset };
}

function readGgufValue(buf, type, offset) {
  if (type === 8) return readGgufString(buf, offset);
  if (type === 9) return readGgufArray(buf, offset);
  return readGgufNumber(buf, type, offset);
}

function isContextLengthKey(key) {
  const k = String(key || '').toLowerCase();
  return (
    k === 'general.context_length' ||
    k.endsWith('.context_length') ||
    k.endsWith('.n_ctx') ||
    k.endsWith('.n_ctx_train') ||
    k.endsWith('.max_position_embeddings') ||
    k.endsWith('.n_positions') ||
    k.endsWith('.seq_length')
  );
}

export function readGgufMetadataFields(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  try {
    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}`;
    if (GGUF_FIELDS_CACHE.has(cacheKey)) return GGUF_FIELDS_CACHE.get(cacheKey);
    const fd = fs.openSync(filePath, 'r');
    try {
      const headerBuf = Buffer.alloc(24);
      fs.readSync(fd, headerBuf, 0, 24, 0);

      const magic = headerBuf.readUInt32LE(0);
      if (magic !== GGUF_MAGIC) return null;

      const version = headerBuf.readUInt32LE(4);
      let metadataKvCount;
      let metadataOffset;

      if (version <= 1) {
        metadataKvCount = Number(headerBuf.readUInt32LE(12));
        metadataOffset = 16;
      } else {
        metadataKvCount = Number(headerBuf.readBigUInt64LE(16));
        metadataOffset = 24;
      }

      const METADATA_READ_LIMIT = Math.min(stat.size, 32 * 1024 * 1024);
      const metaBuf = Buffer.alloc(METADATA_READ_LIMIT);
      fs.readSync(fd, metaBuf, 0, METADATA_READ_LIMIT, metadataOffset);

      const out = {
        architecture: null,
        tokenizer_model: null,
        tokenizer_pre: null,
        general_basename: null,
        general_name: null,
        context_length: null,
        block_count: null,
        embedding_length: null,
        head_count: null,
        head_count_kv: null,
        /** Layers that keep a KV cache; fewer than block_count on hybrid (conv/SSM + attention) models. */
        kv_layer_count: null,
        expert_count: null,
        parameter_count: null,
        chat_template_uses_tools: null,
        chat_template_supports_thinking: null,
        chat_template_present: false,
        chat_template: null,
        has_mtp_layers: null
      };

      let offset = 0;
      for (let i = 0; i < metadataKvCount; i++) {
        if (offset >= METADATA_READ_LIMIT - 12) break;

        const keyParsed = readGgufString(metaBuf, offset);
        const key = keyParsed.value;
        offset += keyParsed.size;

        if (offset + 4 > METADATA_READ_LIMIT) break;
        const valueType = metaBuf.readUInt32LE(offset);
        offset += 4;

        const valueParsed = readGgufValue(metaBuf, valueType, offset);
        if (!valueParsed.size) break;

        const value = valueParsed.value;
        if (key === 'general.architecture' && typeof value === 'string') {
          out.architecture = value;
        }
        if (isContextLengthKey(key)) {
          if (isFinitePositiveInt(Number(value))) out.context_length = Number(value);
        }
        if (key.endsWith('.block_count')) {
          if (isFinitePositiveInt(Number(value))) out.block_count = Number(value);
        }
        if (key.endsWith('.embedding_length')) {
          if (isFinitePositiveInt(Number(value))) out.embedding_length = Number(value);
        }
        if (key.endsWith('.attention.head_count')) {
          if (isFinitePositiveInt(Number(value))) out.head_count = Number(value);
        }
        if (key.endsWith('.attention.head_count_kv')) {
          if (isFinitePositiveInt(Number(value))) out.head_count_kv = Number(value);
          // Hybrid models (LFM, Jamba, Granite-H…) list it per layer, 0 where a
          // layer has no attention. Those layers hold no KV cache, and counting
          // them made a 1.5 GB model "need" 50 GB at long context.
          else if (Array.isArray(value)) {
            const perLayer = value.map(Number).filter((n) => Number.isFinite(n));
            const attention = perLayer.filter((n) => n > 0);
            if (attention.length) {
              out.head_count_kv = Math.max(...attention);
              out.kv_layer_count = attention.length;
            }
          }
        }
        // Present only on MoE architectures; gates the CPU expert-offload control.
        if (key.endsWith('.expert_count')) {
          if (isFinitePositiveInt(Number(value))) out.expert_count = Number(value);
        }
        if (key.endsWith('.parameter_count') || key.endsWith('.n_params')) {
          if (isFinitePositiveInt(Number(value))) out.parameter_count = Number(value);
        }
        if (key === 'tokenizer.ggml.model' && typeof value === 'string') {
          out.tokenizer_model = value;
        }
        if ((key === 'tokenizer.ggml.pre' || key === 'tokenizer.ggml.precompiled') && typeof value === 'string') {
          out.tokenizer_pre = value;
        }
        if (key === 'general.basename' && typeof value === 'string') {
          out.general_basename = value;
        }
        if (key === 'general.name' && typeof value === 'string') {
          out.general_name = value;
        }
        if (key === 'tokenizer.chat_template' && typeof value === 'string') {
          // Shared llama-ui-style detectors (main/chat-templates.ts): the old
          // bare /thinking/i regex fired on template prose and missed the real
          // control variables, so thinking support could be reported either
          // way. Capability probing now reads the raw template through the
          // effective-template resolver, but these flags stay for older
          // consumers.
          out.chat_template_present = true;
          out.chat_template = value;
          out.chat_template_uses_tools = detectTemplateToolSupport(value);
          out.chat_template_supports_thinking = detectTemplateThinkingSupport(value);
        }
        if (key === 'clip.has_vision_encoder' || key === 'general.has_vision') {
          // Reserved for future: not consumed by metadata but recognized.
        }
        if (key === 'mtp.context_length' || key === 'mtp.context_size' || key === 'mtp.head_count') {
          if (out.has_mtp_layers == null) out.has_mtp_layers = true;
        }

        offset += valueParsed.size;
        if (offset > METADATA_READ_LIMIT) break;
      }

      if (GGUF_FIELDS_CACHE.size >= GGUF_FIELDS_CACHE_MAX) {
        const firstKey = GGUF_FIELDS_CACHE.keys().next().value;
        if (firstKey) GGUF_FIELDS_CACHE.delete(firstKey);
      }
      GGUF_FIELDS_CACHE.set(cacheKey, out);
      return out;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function readGgufContextLength(filePath) {
  const fields = readGgufMetadataFields(filePath);
  if (!fields || !isFinitePositiveInt(fields.context_length)) return null;
  return {
    context_length: Number(fields.context_length),
    source: 'gguf',
    file: filePath
  };
}

function buf_readBigUInt64LE_safe(buf, offset) {
  try { return buf.readBigUInt64LE(offset); } catch { return 0n; }
}

// ── System / Backend Detection ──

function detectOsArch() {
  return {
    platform: process.platform,
    arch: process.arch
  };
}

/**
 * Coarse per-platform default used when the user has not pinned a backend.
 * `resolveRuntimeConfig` is the only caller; the precise GPU probes that drive
 * runtime *selection* live in ./gpu-probe.ts.
 */
function detectAvailableBackend() {
  const platform = process.platform;

  function commandExists(command, args = []) {
    try {
      execFileSync(command, args, { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch {
      return false;
    }
  }

  if (platform === 'darwin') {
    return { backend: 'metal', reason: 'macos_metal_default' };
  }

  if (platform === 'linux') {
    // Check for CUDA
    if (commandExists('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'])) {
      return { backend: 'cuda', reason: 'nvidia_smi_detected' };
    }

    // Check for ROCm
    if (commandExists('rocminfo')) {
      return { backend: 'rocm', reason: 'rocminfo_detected' };
    }

    // Check for OpenCL runtime
    if (commandExists('clinfo')) {
      return { backend: 'opencl', reason: 'clinfo_detected' };
    }

    // Vulkan is usually available on Linux
    return { backend: 'vulkan', reason: 'linux_default_vulkan' };
  }

  if (platform === 'win32') {
    if (commandExists('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'])) {
      return { backend: 'cuda', reason: 'nvidia_smi_detected' };
    }

    if (commandExists('clinfo')) {
      return { backend: 'opencl', reason: 'clinfo_detected' };
    }

    return { backend: 'vulkan', reason: 'windows_default_vulkan' };
  }

  return { backend: 'cpu', reason: 'unknown_platform' };
}

function normalizeBackendName(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (!raw) return 'cpu';
  if (raw === 'gpu' || raw === 'default') return 'auto';
  if (raw === 'opencl') return 'opencl';
  if (raw === 'cuda' || raw === 'cublas') return 'cuda';
  if (raw === 'vulkan' || raw === 'vk') return 'vulkan';
  if (raw === 'metal' || raw === 'mtl') return 'metal';
  if (raw === 'hip') return 'hip';
  if (raw === 'rocm') return 'rocm';
  if (raw === 'sycl') return 'sycl';
  if (raw === 'openvino') return 'openvino';
  if (raw === 'webgpu') return 'webgpu';
  if (raw === 'cpu' || raw === 'none') return 'cpu';
  if (raw === 'auto') return 'auto';
  return raw;
}

function backendAliases(backend) {
  if (backend === 'rocm') return ['rocm', 'hip'];
  if (backend === 'hip') return ['hip', 'rocm'];
  return [backend];
}

function listHasAnyBackend(backend, backendSet) {
  return backendAliases(backend).some((name) => backendSet.has(name));
}

function pickAutoBackendOrder(platform) {
  if (platform === 'darwin') return ['metal', 'cuda', 'vulkan', 'hip', 'rocm', 'sycl', 'opencl', 'cpu'];
  if (platform === 'win32') return ['cuda', 'vulkan', 'opencl', 'sycl', 'hip', 'rocm', 'cpu'];
  return ['cuda', 'vulkan', 'hip', 'rocm', 'opencl', 'sycl', 'cpu'];
}

function parseRuntimeListDevicesOutput(output) {
  const availableBackends = new Set(['cpu']);
  const devices = [];

  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const loadedMatch = line.match(/loaded\s+([A-Za-z0-9_+-]+)\s+backend/i);
    if (loadedMatch) {
      const backend = normalizeBackendName(loadedMatch[1]);
      if (backend && backend !== 'rpc' && backend !== 'unknown') availableBackends.add(backend);
      continue;
    }

    const deviceMatch = line.match(/^([A-Za-z]+\d+)\s*:\s*(.+)$/);
    if (!deviceMatch) continue;
    const id = deviceMatch[1].trim();
    const label = deviceMatch[2].trim();
    const prefix = id.replace(/\d+$/, '');
    const backend = normalizeBackendName(prefix);
    devices.push({ id, backend, label });
    if (backend && backend !== 'cpu') availableBackends.add(backend);
  }

  const devicesByBackend = {};
  for (const item of devices) {
    if (!devicesByBackend[item.backend]) devicesByBackend[item.backend] = [];
    devicesByBackend[item.backend].push(item.id);
  }

  return {
    availableBackends: Array.from(availableBackends),
    devices,
    devicesByBackend
  };
}

function probeRuntimeCapabilities(runtimePath) {
  if (!runtimePath || !fs.existsSync(runtimePath)) {
    return {
      runtimePath: runtimePath || null,
      availableBackends: ['cpu'],
      devices: [],
      devicesByBackend: {},
      source: 'no_runtime'
    };
  }

  // The build's own device list (main/runtime-devices.ts): it runs from the
  // build's folder, needs no nvidia-smi or vulkaninfo, and a probe that did not
  // answer is asked again next time instead of being cached as "no GPU".
  const listed = listDevices(runtimePath);
  if (listed === null) {
    log.info(`probeRuntimeCapabilities runtime=${runtimePath} source=probe_failed`);
    return { runtimePath, availableBackends: ['cpu'], devices: [], devicesByBackend: {}, source: 'probe_failed' };
  }
  const parsed = {
    runtimePath,
    ...parseRuntimeListDevicesOutput(listed.map((device) => `${device.id}: ${device.label}`).join('\n')),
    source: 'list_devices'
  };
  log.info(`probeRuntimeCapabilities runtime=${runtimePath} source=${parsed.source} backends=${JSON.stringify(parsed.availableBackends)}`);
  return parsed;
}

export type RuntimeDevice = { id: string; backend: string; name: string; totalMb: number | null; freeMb: number | null };

/**
 * The devices a llama-server build can offload to, as llama.cpp itself lists
 * them (`--list-devices`): the truth for "is there a GPU", which our own
 * hardware probe misses for integrated Radeon/Intel graphics. A CPU-only
 * build lists none even on a machine with a GPU.
 */
export function listRuntimeDevices(runtimePath?: string | null): { runtimePath: string | null; devices: RuntimeDevice[] } {
  const resolvedPath = runtimePath && fs.existsSync(runtimePath) ? runtimePath : resolveRuntimeBinary(runtimePath || '');
  const caps = probeRuntimeCapabilities(resolvedPath);
  const devices = (caps.devices || [])
    .filter((device) => device.backend && device.backend !== 'cpu')
    .map((device) => {
      // "AMD Radeon(TM) Graphics (14026 MiB, 13324 MiB free)"
      const memory = String(device.label).match(/\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/i);
      return {
        id: device.id,
        backend: device.backend,
        name: String(device.label).replace(/\s*\([^)]*MiB[^)]*\)\s*$/i, '').trim(),
        totalMb: memory ? Number(memory[1]) : null,
        freeMb: memory ? Number(memory[2]) : null
      };
    });
  return { runtimePath: caps.runtimePath || null, devices };
}

function pickDeviceForBackend(backend, runtimeCaps) {
  if (!runtimeCaps || !runtimeCaps.devicesByBackend) return null;
  for (const alias of backendAliases(backend)) {
    const list = runtimeCaps.devicesByBackend[alias];
    if (Array.isArray(list) && list.length) return list[0];
  }
  return null;
}

// ── Runtime Config Resolution ──

/**
 * Resolves backend, device, context and layer counts for a model.
 *
 * Two callers with different needs:
 *
 * - `buildLlamaArgs` uses this for backend/device selection, and consults the
 *   `*Source` fields to decide which values are worth passing on the command
 *   line at all. Anything we leave off is sized by llama.cpp's own `--fit`,
 *   which measures real device memory instead of estimating from file size.
 * - `getRecommendedSettings` uses the estimated context/layer numbers to fill
 *   the load dialog's "Apply recommended" preset and memory gauges.
 *
 * So the heuristic branches below still earn their keep for the second caller
 * even though they no longer drive startup.
 */
export function resolveRuntimeConfig(options = {}) {
  const {
    modelPath,
    runtimePath,
    userBackend,
    userGpuLayers,
    userContextSize,
    batchSize,
    ubatchSize,
    tensorSplit,
    mainGpu,
    systemInfo = null
  } = options;

  const reasonLog = [];
  const osArch = detectOsArch();
  let ggufFields = null;
  if (modelPath) {
    try { ggufFields = readGgufMetadataFields(modelPath); } catch { /* ignore */ }
  }

  // 1. Resolve runtime path - try multiple strategies
  let effectiveRuntimePath = runtimePath;
  let runtimeSource = 'explicit';
  if (!effectiveRuntimePath || !fs.existsSync(effectiveRuntimePath)) {
    // Try to auto-discover runtime from config or system
    const autoResolved = resolveRuntimeBinary('');
    if (autoResolved && fs.existsSync(autoResolved)) {
      effectiveRuntimePath = autoResolved;
      runtimeSource = 'auto_discovered';
    }
  }

  // Probe the resolved runtime
  const runtimeCaps = probeRuntimeCapabilities(effectiveRuntimePath);
  const runtimeBackends = new Set((runtimeCaps.availableBackends || []).map(normalizeBackendName));

  log.info(`resolveRuntimeConfig model=${modelPath ? path.basename(modelPath) : 'none'} runtime=${effectiveRuntimePath ? path.basename(effectiveRuntimePath) : 'null'} runtimeSource=${runtimeSource} runtimeBackends=${JSON.stringify(runtimeCaps.availableBackends)} userBackend=${userBackend}`);

  // 2. Backend resolution
  let backend = normalizeBackendName(userBackend || 'auto');
  let selectedDevice = null;

  // Helper to perform auto-detection using current runtime capabilities
  function doAutoDetection(currentRuntimeBackends, currentRuntimeCaps) {
    const autoOrder = pickAutoBackendOrder(osArch.platform);
    for (const candidate of autoOrder) {
      if (candidate === 'cpu') {
        reasonLog.push('auto_detected=cpu(no_gpu_in_runtime)');
        return 'cpu';
      }
      if (listHasAnyBackend(candidate, currentRuntimeBackends)) {
        const device = pickDeviceForBackend(candidate, currentRuntimeCaps);
        if (device) {
          reasonLog.push(`auto_detected=${candidate}(device=${device})`);
          return { backend: candidate, device };
        }
      }
    }
    // Fall back to system detection
    const sysBackend = detectAvailableBackend();
    reasonLog.push(`auto_detected=${sysBackend.backend}(${sysBackend.reason})`);
    return { backend: sysBackend.backend, device: null };
  }

  // Handle 'api' or invalid backend - switch to 'auto' when we have a runtime
  if ((backend === 'api' || !BACKENDS.includes(backend)) && effectiveRuntimePath && fs.existsSync(effectiveRuntimePath) && modelPath) {
    if (!BACKENDS.includes(backend)) {
      reasonLog.push(`invalid_backend=${backend},switching_to_auto`);
    } else {
      reasonLog.push(`api_mode_with_local_runtime=switching_to_auto`);
    }
    backend = 'auto';
  }

  if (backend === 'auto') {
    const result = doAutoDetection(runtimeBackends, runtimeCaps);
    if (typeof result === 'string') {
      backend = result;
    } else {
      backend = result.backend;
      selectedDevice = result.device;
    }
  } else if (BACKENDS.includes(backend)) {
    reasonLog.push(`user_requested=${backend}`);
  }

  if (!BACKENDS.includes(backend)) {
    reasonLog.push(`invalid_backend=${backend},fallback=cpu`);
    backend = 'cpu';
  }

  if (backend !== 'cpu') {
    if (!listHasAnyBackend(backend, runtimeBackends)) {
      reasonLog.push(`backend_unavailable_in_runtime=${backend},fallback=cpu`);
      backend = 'cpu';
    }
  }

  if (backend !== 'cpu' && !selectedDevice) {
    selectedDevice = pickDeviceForBackend(backend, runtimeCaps);
  }

  if (backend !== 'cpu' && !selectedDevice) {
    reasonLog.push(`backend_no_device=${backend},fallback=cpu`);
    backend = 'cpu';
  }

  // 3. GGUF context length
  let ggufContextLength = null;
  if (isFinitePositiveInt(Number(ggufFields?.context_length))) {
    ggufContextLength = Number(ggufFields.context_length);
    reasonLog.push(`gguf_context=${ggufContextLength}`);
  } else if (modelPath) {
    reasonLog.push('gguf_context=not_found');
  }

  // 3. Context size resolution (user > gguf > default)
  let contextSize;
  let contextSource = 'default';

  const userContextNumeric = Number(userContextSize);
  const hasUserContext = userContextSize != null && userContextSize !== '' && Number.isFinite(userContextNumeric) && userContextNumeric > 0;

  if (hasUserContext) {
    contextSize = userContextNumeric;
    contextSource = 'user';
    reasonLog.push(`context_user=${contextSize}`);
  } else if (ggufContextLength != null) {
    contextSize = ggufContextLength;
    contextSource = 'gguf';
    reasonLog.push(`context_from_gguf=${contextSize}`);
  } else {
    contextSize = DEFAULT_CONTEXT_FALLBACK;
    contextSource = 'default';
    reasonLog.push(`context_default=${contextSize}`);
  }

  // 4. GPU layers resolution
  const ggufBlockCount = Number(ggufFields?.block_count || 0);
  const hasModelBlockCount = Number.isFinite(ggufBlockCount) && ggufBlockCount > 0;
  let gpuLayers = 0;
  const isGpuBackend = backend !== 'cpu';
  const gpuLayersRaw = userGpuLayers;
  const userGpuMode = typeof gpuLayersRaw === 'string' ? gpuLayersRaw.trim().toLowerCase() : null;
  const userGpuNumeric = Number(gpuLayersRaw);
  const hasUserGpuNumeric = gpuLayersRaw != null && gpuLayersRaw !== '' && Number.isFinite(userGpuNumeric) && userGpuNumeric >= 0;
  const userAskedMaxGpu = userGpuMode === 'max' || userGpuMode === 'all';

  if (!isGpuBackend) {
    gpuLayers = 0;
  } else if (userAskedMaxGpu) {
    gpuLayers = hasModelBlockCount ? ggufBlockCount : 999;
    reasonLog.push(`gpu_layers_user=max(resolved=${gpuLayers})`);
  } else if (hasUserGpuNumeric) {
    gpuLayers = Math.max(0, Math.floor(userGpuNumeric));
    reasonLog.push(`gpu_layers_user=${gpuLayers}`);
  } else if (systemInfo?.vram_gb > 0) {
    // Auto-calculate based on VRAM
    const fileSizeGb = modelPath && fs.existsSync(modelPath)
      ? fs.statSync(modelPath).size / (1024 ** 3)
      : 0;
    const fullOffloadLayers = hasModelBlockCount ? ggufBlockCount : 999;
    const heuristicLayerCount = hasModelBlockCount ? ggufBlockCount : 32;

    if (fileSizeGb > 0) {
      if (fileSizeGb < systemInfo.vram_gb * 0.8) {
        gpuLayers = fullOffloadLayers;
        reasonLog.push(`gpu_layers=full_offload(file=${fileSizeGb.toFixed(1)}GB,vram=${systemInfo.vram_gb}GB)`);
      } else if (fileSizeGb < systemInfo.vram_gb * 1.2) {
        gpuLayers = Math.floor(heuristicLayerCount * (systemInfo.vram_gb / fileSizeGb));
        reasonLog.push(`gpu_layers=partial(${gpuLayers},file=${fileSizeGb.toFixed(1)}GB,vram=${systemInfo.vram_gb}GB)`);
      } else {
        gpuLayers = 0;
        reasonLog.push(`gpu_layers=0(file_too_large=${fileSizeGb.toFixed(1)}GB>vram=${systemInfo.vram_gb}GB)`);
      }
    } else {
      gpuLayers = 0;
      reasonLog.push('gpu_layers=0(no_file_size_info)');
    }
  } else {
    reasonLog.push('gpu_layers=0(no_gpu_or_user_not_set)');
  }

  if (hasModelBlockCount && gpuLayers > ggufBlockCount) {
    reasonLog.push(`gpu_layers_clamped_to_block_count(${gpuLayers}->${ggufBlockCount})`);
    gpuLayers = ggufBlockCount;
  }

  // Clamp GPU layers to 0 if CPU backend
  if (backend === 'cpu' && gpuLayers > 0) {
    reasonLog.push(`gpu_layers_clamped_to_0(cpu_backend)`);
    gpuLayers = 0;
  }

  // 5. Memory heuristics - clamp context if too high
  const totalRamGb = systemInfo?.total_ram_gb || os.totalmem() / (1024 ** 3);
  const estimatedMemoryGb = estimateContextMemory(contextSize, gpuLayers > 0);

  // Never on a context the user chose: that is the only kind that reaches the
  // command line, so this used to silently shrink every explicit choice.
  // llama.cpp reports a real out-of-memory, which the load dialog shows.
  if (contextSource !== 'user' && estimatedMemoryGb > totalRamGb * 0.7 && contextSize > MIN_CONTEXT_SIZE) {
    const originalContext = contextSize;
    while (contextSize > MIN_CONTEXT_SIZE) {
      contextSize = Math.floor(contextSize * CONTEXT_DOWNSCALE_STEP);
      const newEst = estimateContextMemory(contextSize, gpuLayers > 0);
      if (newEst < totalRamGb * 0.7) {
        reasonLog.push(`context_clamped(${originalContext}->${contextSize},memory_heuristic)`);
        break;
      }
    }
  }

  // 6. Batch size defaults
  const effectiveBatchSize = batchSize || (gpuLayers > 0 ? 512 : 256);
  const effectiveUbatchSize = ubatchSize || Math.min(effectiveBatchSize, 512);

  // 7. Build final config
  const resolved = {
    backend,
    selectedDevice,
    runtimePath: effectiveRuntimePath || null,
    availableBackends: runtimeCaps.availableBackends || ['cpu'],
    /** 'list_devices' when the build answered; anything else means we do not know its devices. */
    deviceSource: runtimeCaps.source,
    gpuLayers,
    contextSize,
    batchSize: effectiveBatchSize,
    ubatchSize: effectiveUbatchSize,
    tensorSplit: tensorSplit || null,
    mainGpu: mainGpu ?? null,
    ggufContextLength,
    ggufBlockCount: hasModelBlockCount ? ggufBlockCount : null,
    contextSource,
    // Provenance: 'user' means the person picked this number and we must honour
    // it. Anything else is our estimate, which llama.cpp's --fit beats.
    gpuLayersSource: (userAskedMaxGpu || hasUserGpuNumeric) ? 'user' : 'auto',
    batchSource: batchSize ? 'user' : 'auto',
    ubatchSource: ubatchSize ? 'user' : 'auto',
    reasonLog
  };

  return resolved;
}

function estimateContextMemory(contextSize, isGpu) {
  // Rough estimate: ~2 bytes per token per parameter billion for KV cache
  // Plus model weights memory
  // This is a very rough heuristic
  const kvCacheGb = (contextSize / 1024) * 0.1; // ~100MB per 1K tokens
  const overheadGb = isGpu ? 1.0 : 0.5;
  return kvCacheGb + overheadGb;
}

// ── Startup Log Line ──

export function formatStartupLog(resolved) {
  // `(auto)` marks values we resolved for display but did not pass on the
  // command line — llama.cpp's own --fit decides those.
  const mark = (source) => (source === 'user' ? '' : '(auto)');
  const parts = [
    `[runtime]`,
    `backend=${resolved.backend}`,
    resolved.selectedDevice ? `device=${resolved.selectedDevice}` : null,
    `gpuLayers=${resolved.gpuLayers}${mark(resolved.gpuLayersSource)}`,
    `ctx=${resolved.contextSize}${mark(resolved.contextSource)}`,
  ].filter(Boolean);

  if (resolved.ggufContextLength != null) {
    parts.push(`ggufCtx=${resolved.ggufContextLength}`);
  }

  if (resolved.reasonLog.length > 0) {
    parts.push(`fallback=${resolved.reasonLog.join(',')}`);
  }

  return parts.join(' ');
}
