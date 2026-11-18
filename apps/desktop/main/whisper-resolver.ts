import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './paths.ts';
import { loadConfig, saveConfig } from './config.ts';
import { hasNvidiaGpu, hasVulkanSupport } from './gpu-probe.ts';

const isWindows = process.platform === 'win32';
const WHISPER_CLI_NAMES = isWindows
  ? ['whisper-cli.exe', 'whisper.exe', 'main.exe']
  : ['whisper-cli', 'whisper', 'main'];

function inferWhisperVariant(runtimePath: string): string {
  const value = String(runtimePath || '').toLowerCase();
  if (value.includes('cuda')) return 'cuda';
  if (value.includes('vulkan')) return 'vulkan';
  if (value.includes('hip') || value.includes('rocm')) return 'rocm';
  if (value.includes('metal')) return 'metal';
  if (value.includes('cpu')) return 'cpu';
  return 'unknown';
}

function findWhisperBinaryInDir(dirPath: string): string[] {
  for (const bin of WHISPER_CLI_NAMES) {
    const top = path.join(dirPath, bin);
    if (fs.existsSync(top)) return [top];
  }

  // Collect every candidate, then take the best name: current releases still
  // ship a `main` that only prints a deprecation notice and exits with 1.
  const found: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (WHISPER_CLI_NAMES.includes(entry.name)) found.push(full);
    }
  }
  walk(dirPath, 0);
  found.sort((a, b) => WHISPER_CLI_NAMES.indexOf(path.basename(a)) - WHISPER_CLI_NAMES.indexOf(path.basename(b)));
  return found.slice(0, 1);
}

interface WhisperRuntime {
  id: string;
  name: string;
  path: string;
  variant: string;
  size_gb: number;
  modified: number;
  is_active: boolean;
}

export function listWhisperBinaries(): WhisperRuntime[] {
  const paths = getAppPaths();
  const cfg = loadConfig();
  const configuredPath = String(cfg.stt?.runtime_path || '').trim();
  const runtimes: WhisperRuntime[] = [];
  const versionsDir = paths.whisperBinVersionsRoot;

  if (fs.existsSync(versionsDir)) {
    const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(versionsDir, entry.name);
      const binaries = findWhisperBinaryInDir(dirPath);
      if (!binaries.length) continue;
      const binPath = binaries[0];
      const stat = fs.statSync(binPath);
      const isActive = configuredPath ? configuredPath === binPath : false;
      runtimes.push({
        id: entry.name,
        name: entry.name,
        path: binPath,
        variant: inferWhisperVariant(entry.name || binPath),
        size_gb: Math.round((stat.size / (1024 ** 3)) * 100) / 100,
        modified: stat.mtimeMs,
        is_active: isActive,
      });
    }
  }

  const directBin = path.join(paths.whisperBinRoot, isWindows ? 'whisper-cli.exe' : 'whisper-cli');
  if (fs.existsSync(directBin)) {
    const stat = fs.statSync(directBin);
    runtimes.push({
      id: 'default',
      name: 'default',
      path: directBin,
      variant: inferWhisperVariant(directBin),
      size_gb: Math.round((stat.size / (1024 ** 3)) * 100) / 100,
      modified: stat.mtimeMs,
      is_active: configuredPath ? configuredPath === directBin : false,
    });
  }

  const bundledRoot = path.join(paths.nativeBinRoot || '', 'whisper');
  if (fs.existsSync(bundledRoot)) {
    const entries = fs.readdirSync(bundledRoot, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = entry.isDirectory() ? path.join(bundledRoot, entry.name) : bundledRoot;
      const binaries = findWhisperBinaryInDir(candidate);
      if (!binaries.length) {
        if (!entry.isDirectory()) break;
        continue;
      }
      const binPath = binaries[0];
      const stat = fs.statSync(binPath);
      const id = `bundled-${entry.isDirectory() ? entry.name : 'default'}`;
      runtimes.push({
        id,
        name: id,
        path: binPath,
        variant: inferWhisperVariant(entry.name || binPath),
        size_gb: Math.round((stat.size / (1024 ** 3)) * 100) / 100,
        modified: stat.mtimeMs,
        is_active: configuredPath ? configuredPath === binPath : false,
      });
      if (!entry.isDirectory()) break;
    }
  }

  return runtimes.sort((a, b) => {
    if (!!b.is_active !== !!a.is_active) return Number(!!b.is_active) - Number(!!a.is_active);
    if ((b.modified || 0) !== (a.modified || 0)) return (b.modified || 0) - (a.modified || 0);
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

export function resolveWhisperBinary(explicitPath = ''): string | null {
  const cfg = loadConfig();
  const candidates: string[] = [];

  if (explicitPath) candidates.push(explicitPath);
  const configPath = String(cfg.stt?.runtime_path || '').trim();
  if (configPath) candidates.push(configPath);

  for (const runtime of listWhisperBinaries()) {
    candidates.push(runtime.path);
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function clearWhisperSelectionFromConfig(binPath: string): void {
  const cfg = loadConfig();
  const next = structuredClone(cfg);
  let dirty = false;

  if (next.stt?.runtime_path && next.stt.runtime_path === binPath) {
    next.stt.runtime_path = '';
    dirty = true;
  }
  if (dirty) saveConfig(next);
}

export function deleteWhisperBinary(binPath: string): void {
  const paths = getAppPaths();

  if (binPath.startsWith(paths.whisperBinVersionsRoot)) {
    const versionDir = path.dirname(binPath);
    if (fs.existsSync(versionDir) && versionDir.startsWith(paths.whisperBinVersionsRoot)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
  } else if (fs.existsSync(binPath)) {
    fs.unlinkSync(binPath);
  }

  clearWhisperSelectionFromConfig(binPath);
}

export interface WhisperBackendInfo {
  backend: 'cuda' | 'vulkan' | 'cpu';
  reason: string;
  hasCuda: boolean;
  hasVulkan: boolean;
}

export function detectBestBackend(): WhisperBackendInfo {
  const hasCuda = hasNvidiaGpu();
  const hasVulkan = !hasCuda && hasVulkanSupport();

  if (hasCuda) {
    return { backend: 'cuda', reason: 'NVIDIA GPU detected via nvidia-smi', hasCuda, hasVulkan };
  }
  if (hasVulkan) {
    return { backend: 'vulkan', reason: 'Vulkan support detected', hasCuda, hasVulkan };
  }
  return { backend: 'cpu', reason: 'No GPU backend detected, using CPU', hasCuda, hasVulkan };
}
