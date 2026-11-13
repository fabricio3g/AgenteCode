import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './paths.ts';
import { loadConfig, saveConfig } from './config.ts';
import { hasGpuDevice } from './runtime-devices.ts';

/** Variant order among builds that tie on reaching a GPU: the faster backend first. */
function preferredRuntimeVariants(cfg) {
  const requested = String(cfg?.llm?.local?.binary?.install_variant || 'auto').toLowerCase();
  const base = ['cuda', 'rocm', 'metal', 'vulkan', 'sycl', 'opencl', 'cpu', 'unknown'];
  if (requested === 'cuda12' || requested === 'cuda13') return base;
  return requested && requested !== 'auto' ? [requested, ...base.filter((variant) => variant !== requested)] : base;
}

/**
 * Builds that can reach a GPU here first (as each one's own --list-devices
 * says), then by backend, then newest. The old order came from nvidia-smi and
 * vulkaninfo, which are missing on most Windows machines, so a CPU-only build
 * ranked first on a machine with a GPU.
 */
function orderRuntimesForPreference(runtimes, cfg) {
  const order = preferredRuntimeVariants(cfg);
  const reach = new Map(runtimes.map((runtime) => [runtime.path, hasGpuDevice(runtime.path) === true]));
  return [...runtimes].sort((left, right) => {
    const gpu = Number(reach.get(right.path)) - Number(reach.get(left.path));
    if (gpu) return gpu;
    const leftRank = order.indexOf(left.variant);
    const rightRank = order.indexOf(right.variant);
    const normalizedLeftRank = leftRank === -1 ? order.length : leftRank;
    const normalizedRightRank = rightRank === -1 ? order.length : rightRank;
    if (normalizedLeftRank !== normalizedRightRank) return normalizedLeftRank - normalizedRightRank;
    if ((right.modified || 0) !== (left.modified || 0)) return (right.modified || 0) - (left.modified || 0);
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
}

function inferRuntimeVariant(runtimePath) {
  const value = String(runtimePath || '').toLowerCase();
  if (value.includes('cuda')) return 'cuda';
  if (value.includes('vulkan')) return 'vulkan';
  if (value.includes('opencl') || value.includes('clblast') || value.includes('clblas')) return 'opencl';
  if (value.includes('metal')) return 'metal';
  if (value.includes('rocm') || value.includes('hip')) return 'rocm';
  if (value.includes('sycl')) return 'sycl';
  if (value.includes('openvino')) return 'openvino';
  if (value.includes('webgpu')) return 'webgpu';
  if (value.includes('cpu')) return 'cpu';
  return 'unknown';
}

function runtimeCandidatesFromDirectory(dirPath) {
  // Only llama-server implements the HTTP API consumed by this application.
  // llama-cli may accept a few overlapping flags but cannot serve chat requests.
  const priorityCandidates = ['llama-server', 'llama-server.exe'];

  // Check top level first for priority candidates
  for (const bin of priorityCandidates) {
    const top = path.join(dirPath, bin);
    if (fs.existsSync(top)) return [top];
  }

  // Search recursively
  const allCandidates = priorityCandidates;
  const found = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (allCandidates.includes(entry.name)) found.push(full);
    }
  }
  walk(dirPath);
  return found;
}

function resolveRuntimeCandidate(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return null;
  const stat = fs.statSync(candidate);
  if (stat.isDirectory()) {
    return runtimeCandidatesFromDirectory(candidate)[0] || null;
  }
  return candidate;
}

export function listRuntimeBinaries() {
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

  const bundledRoot = path.join(paths.nativeBinRoot || '', 'llama');
  if (fs.existsSync(bundledRoot)) {
    const bundledEntries = fs.readdirSync(bundledRoot, { withFileTypes: true });
    for (const entry of bundledEntries) {
      const candidate = entry.isDirectory() ? path.join(bundledRoot, entry.name) : bundledRoot;
      for (const binPath of runtimeCandidatesFromDirectory(candidate)) {
        const stat = fs.statSync(binPath);
        const id = `bundled-${entry.isDirectory() ? entry.name : 'default'}`;
        const selected = resolvedActiveRuntimePath ? resolvedActiveRuntimePath === binPath : false;
        runtimes.push({
          id,
          name: id,
          path: binPath,
          variant: inferRuntimeVariant(entry.name || binPath),
          size_gb: Math.round((stat.size / (1024 ** 3)) * 100) / 100,
          modified: stat.mtimeMs,
          is_active: selected
        });
        break;
      }
      if (!entry.isDirectory()) break;
    }
  }

  return runtimes.sort((left, right) => {
    if (!!right.is_active !== !!left.is_active) return Number(!!right.is_active) - Number(!!left.is_active);
    if ((right.modified || 0) !== (left.modified || 0)) return (right.modified || 0) - (left.modified || 0);
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
}

/**
 * The engine a launch uses: the one asked for, else the one chosen in
 * settings, else the best installed build (see orderRuntimesForPreference).
 * An explicit or chosen engine answers without listing or probing the others.
 */
export function resolveRuntimeBinary(explicitPath = '') {
  const cfg = loadConfig();
  for (const candidate of [explicitPath, cfg.llm?.local?.runtime_path, cfg.llm?.local?.binary?.path]) {
    const resolved = candidate ? resolveRuntimeCandidate(candidate) : null;
    if (resolved) return resolved;
  }
  for (const runtime of orderRuntimesForPreference(listRuntimeBinaries(), cfg)) {
    const resolved = resolveRuntimeCandidate(runtime.path);
    if (resolved) return resolved;
  }
  return null;
}

export function clearRuntimeSelectionFromConfig(binPath) {
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
