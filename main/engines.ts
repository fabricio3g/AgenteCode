/**
 * "On this computer": the engines installed in the data folder, their
 * versions and updates, and what the folder holds.
 *
 * Engines install side by side (engines/<engine>/<build>/), so an update
 * never replaces a working build: the new one is selected and the previous
 * one stays for a rollback until "Clean up" removes the rest.
 */

import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import { getAppPaths } from './paths.ts';
import { loadConfig, saveConfig } from './config.ts';
import { listRuntimeBinaries } from './runtime-resolver.ts';
import { listWhisperBinaries, resolveWhisperBinary } from './whisper-resolver.ts';
import { downloadWhisperRuntime } from './whisper-download.ts';
import { findWhisperServer, stopWhisperServer, whisperGpuInfo } from './whisper-server.ts';
import { findWhisperRuntimeAsset } from './voice-setup.ts';

export type EngineBuild = {
  id: string;
  tag: string;
  variant: string;
  path: string;
  selected: boolean;
  bytes: number;
  modified: number;
};

export type EngineOverview = {
  llama: { builds: EngineBuild[] };
  whisper: { builds: EngineBuild[]; gpu: ReturnType<typeof whisperGpuInfo>; server: boolean };
  storage: { root: string; total: number; categories: Record<'chat' | 'speech' | 'voices' | 'engines' | 'other', number> };
};

/** "b10442-llama-b10442-bin-ubuntu-vulkan-x64" → "b10442". */
export function buildTag(id: string): string {
  return /^(b\d+|v[\d.]+)/i.exec(id)?.[1] ?? id;
}

/** Total size of a file or folder, without following links. */
export function folderBytes(target: string): number {
  let total = 0;
  const walk = (p: string) => {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(p); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) { total += stat.size; return; }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  };
  walk(target);
  return total;
}

/** The build's own folder: engines/<engine>/<build>/. */
function buildDir(binaryPath: string, versionsRoot: string): string {
  const rel = path.relative(versionsRoot, binaryPath).split(path.sep);
  return rel.length > 1 && rel[0] !== '..' ? path.join(versionsRoot, rel[0]) : path.dirname(binaryPath);
}

function toBuilds(list: Array<{ id: string; path: string; variant: string; modified: number; is_active: boolean }>, versionsRoot: string): EngineBuild[] {
  return list.map((item) => ({
    id: item.id,
    tag: buildTag(item.id),
    variant: item.variant,
    path: item.path,
    selected: item.is_active,
    bytes: folderBytes(buildDir(item.path, versionsRoot)),
    modified: item.modified
  }));
}

export function getEngineOverview(): EngineOverview {
  const paths = getAppPaths();
  const llama = toBuilds(listRuntimeBinaries(), paths.localBinVersionsRoot);
  if (llama.length && !llama.some((b) => b.selected)) llama[0].selected = true; // the resolver's pick

  const activeWhisper = resolveWhisperBinary();
  const whisper = toBuilds(listWhisperBinaries(), paths.whisperBinVersionsRoot)
    .map((b) => ({ ...b, selected: b.path === activeWhisper }));
  const server = findWhisperServer(activeWhisper);

  const categories = {
    chat: folderBytes(paths.localModelsRoot),
    speech: folderBytes(paths.speechModelsRoot),
    voices: folderBytes(paths.voiceModelsRoot),
    engines: folderBytes(paths.enginesRoot),
    other: 0
  };
  const total = folderBytes(paths.appData);
  categories.other = Math.max(0, total - categories.chat - categories.speech - categories.voices - categories.engines);

  return {
    llama: { builds: llama },
    whisper: { builds: whisper, gpu: server ? whisperGpuInfo(path.dirname(server)) : { source: 'none', backend: null }, server: !!server },
    storage: { root: paths.appData, total, categories }
  };
}

/** The newest whisper.cpp build for this computer, when it is newer than what is installed. */
export async function checkWhisperUpdate(): Promise<{ tag: string; asset: string } | null> {
  const asset = await findWhisperRuntimeAsset();
  if (!asset) return null;
  const installed = listWhisperBinaries().map((b) => buildTag(b.id));
  return installed.includes(asset.tag) ? null : { tag: asset.tag, asset: asset.name };
}

/** Install the newest whisper.cpp build next to the current one and switch to it. */
export async function updateWhisperEngine(): Promise<EngineOverview> {
  const asset = await findWhisperRuntimeAsset();
  if (!asset) throw new Error('No whisper.cpp build was found for this system.');
  const result = await downloadWhisperRuntime({ download_url: asset.url, asset_name: asset.name, release_tag: asset.tag });
  stopWhisperServer();
  const cfg = loadConfig();
  saveConfig({ ...cfg, stt: { ...cfg.stt, runtime_path: result.path } });
  return getEngineOverview();
}

/**
 * Remove old builds: keep the selected one and the newest other one (for a
 * rollback) per engine. Bundled builds are never touched.
 */
export function cleanupEngines(): { freed: number; removed: string[] } {
  const paths = getAppPaths();
  const overview = getEngineOverview();
  const removed: string[] = [];
  let freed = 0;
  const sweep = (builds: EngineBuild[], versionsRoot: string) => {
    const others = builds
      .filter((b) => !b.selected && path.relative(versionsRoot, b.path).split(path.sep)[0] !== '..')
      .sort((a, b) => b.modified - a.modified);
    for (const build of others.slice(1)) {
      const dir = buildDir(build.path, versionsRoot);
      if (dir === versionsRoot) continue;
      freed += build.bytes;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(build.id);
    }
  };
  sweep(overview.llama.builds, paths.localBinVersionsRoot);
  sweep(overview.whisper.builds, paths.whisperBinVersionsRoot);
  return { freed, removed };
}

export async function openDataFolder(sub = ''): Promise<void> {
  const paths = getAppPaths();
  const target = path.join(paths.appData, sub);
  fs.mkdirSync(target, { recursive: true });
  await shell.openPath(target);
}
