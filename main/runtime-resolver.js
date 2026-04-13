import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './index.js';
import { loadConfig, saveConfig } from './config.js';

export function inferRuntimeVariant(runtimePath) {
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

export function runtimeCandidatesFromDirectory(dirPath) {
  // Priority order: llama-server first (preferred for server mode),
  // then llama-cli (works for probing --list-devices)
  const priorityCandidates = ['llama-server', 'llama-server.exe'];
  const fallbackCandidates = ['llama-cli', 'llama-cli.exe', 'server'];

  // Check top level first for priority candidates
  for (const bin of priorityCandidates) {
    const top = path.join(dirPath, bin);
    if (fs.existsSync(top)) return [top];
  }

  // Check top level for fallback candidates
  for (const bin of fallbackCandidates) {
    const top = path.join(dirPath, bin);
    if (fs.existsSync(top)) return [top];
  }

  // Search recursively
  const allCandidates = [...priorityCandidates, ...fallbackCandidates];
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

export function resolveRuntimeCandidate(candidate) {
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

  return runtimes.sort((left, right) => {
    if (!!right.is_active !== !!left.is_active) return Number(!!right.is_active) - Number(!!left.is_active);
    if ((right.modified || 0) !== (left.modified || 0)) return (right.modified || 0) - (left.modified || 0);
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
}

export function resolveRuntimeBinary(explicitPath = '') {
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
