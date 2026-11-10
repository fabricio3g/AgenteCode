// ── Where audio.cpp lives, and how to get it ───────────────────────────────
// A release build carries audio.cpp in resources/bin/audio/<backend>. A build
// without it (development, or a slim package) downloads the same release from
// Settings → On this computer into <app data>/engines/audio.cpp/<backend>,
// laid out the same way: the server, its libraries, model_specs/ and
// BUILD_INFO.txt. A downloaded backend wins over a bundled one, so an update
// takes effect without touching the app's own files.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WebContents } from 'electron';
import { getAppPaths } from '../paths.ts';
import { extractArchive, markExecutable, resetDirectory } from '../archive-install.ts';
import TESTED from '../../shared/engine-versions.json';

export type AudioBackend = 'cpu' | 'vulkan';

const REPO = '0xShug0/audio.cpp';
const SERVER = process.platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server';
const LIBRARY = /\.(so(\.\d+)*|dll|dylib|metallib)$/i;

/** The release asset per platform and backend (the same table the build script uses). */
const ASSETS: Record<string, Partial<Record<AudioBackend, string>>> = {
  'linux-x64': { cpu: 'audio-{tag}-bin-ubuntu-x64-cpu-portable.tar.gz', vulkan: 'audio-{tag}-bin-ubuntu-x64-vulkan-portable.tar.gz' },
  'win32-x64': { cpu: 'audio-{tag}-bin-windows-x64-cpu-portable.zip', vulkan: 'audio-{tag}-bin-windows-x64-vulkan.zip' }
};

function roots(): string[] {
  const paths = getAppPaths();
  return [paths.audioBinRoot, path.join(paths.nativeBinRoot, 'audio')];
}

/** The folder holding `backend`'s server: downloaded first, then bundled. */
export function audioEngineDir(backend: string): string | null {
  return roots().map((root) => path.join(root, backend)).find((dir) => fs.existsSync(path.join(dir, SERVER))) ?? null;
}

export function audioEngineBinary(backend: string): string | null {
  const dir = audioEngineDir(backend);
  return dir ? path.join(dir, SERVER) : null;
}

export function installedAudioBackends(): AudioBackend[] {
  return (['cpu', 'vulkan'] as const).filter((backend) => audioEngineDir(backend));
}

/** Backends published for this machine, whether or not one is installed. */
export function downloadableAudioBackends(): AudioBackend[] {
  return Object.keys(ASSETS[`${process.platform}-${process.arch}`] ?? {}) as AudioBackend[];
}

/** audio.cpp's model definitions, from whichever backend is installed. */
export function audioSpecsDir(): string | null {
  return (['vulkan', 'cpu'] as const)
    .map((backend) => audioEngineDir(backend))
    .map((dir) => dir && path.join(dir, 'model_specs'))
    .find((dir) => dir && fs.existsSync(dir)) ?? null;
}

/** The installed release (`BUILD_INFO.txt`), e.g. `v0.8.2`. */
export function audioEngineVersion(): string | null {
  for (const backend of installedAudioBackends()) {
    try {
      const info = fs.readFileSync(path.join(audioEngineDir(backend)!, 'BUILD_INFO.txt'), 'utf8');
      const release = info.match(/^release=(.+)$/m)?.[1]?.trim();
      if (release) return release;
    } catch { /* older bundles have no build info */ }
  }
  return null;
}

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Download the tested audio.cpp release for `backend` and install it. The
 * caller stops the running server first: Windows cannot replace a loaded exe.
 */
export async function installAudioEngine(backend: AudioBackend, sender?: WebContents): Promise<{ version: string; path: string }> {
  const tag = TESTED.audio;
  const template = ASSETS[`${process.platform}-${process.arch}`]?.[backend];
  if (!template) throw new Error(`audio.cpp publishes no ${backend} build for this computer.`);
  const assetName = template.replaceAll('{tag}', tag);
  const emit = (progress: number, phase: string) => {
    try { if (sender && !sender.isDestroyed()) sender.send('audio-runtime-download-progress', { progress, phase, backend }); } catch { /* window closed */ }
  };

  emit(0, 'downloading');
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
    headers: { 'User-Agent': 'agente-desktop', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Could not read the audio.cpp ${tag} release (HTTP ${response.status}).`);
  const release = await response.json() as { assets: Array<{ name: string; browser_download_url: string; digest?: string }> };
  const asset = release.assets.find((entry) => entry.name === assetName);
  if (!asset) throw new Error(`audio.cpp ${tag} has no ${assetName}.`);

  const paths = getAppPaths();
  const archive = path.join(paths.cacheRoot, assetName);
  const unpacked = path.join(paths.cacheRoot, `${assetName}.d`);
  const target = path.join(paths.audioBinRoot, backend);
  const staged = `${target}.install-${process.pid}`;
  // Loaded here, not at the top: the downloader reaches Electron's windows,
  // which the unit tests importing the speech module do not have.
  const { trackDownload } = await import('../model-download.ts');
  try {
    // Downloading owns 0-80%, checking and unpacking the rest.
    await trackDownload({ url: asset.browser_download_url, dest: archive, label: `audio.cpp ${tag} (${backend})`, category: 'engine' }, (fraction) => {
      emit(Math.round(fraction * 80), 'downloading');
    });
    const [algorithm, expected] = String(asset.digest || '').split(':');
    if (algorithm === 'sha256' && await sha256(archive) !== expected) throw new Error(`${assetName} failed its checksum. Try the download again.`);

    emit(80, 'extracting');
    resetDirectory(unpacked);
    await extractArchive(assetName, archive, unpacked, 'audio.cpp');

    // Ship what the build script ships: the server, its libraries, the licenses, model_specs/.
    resetDirectory(staged);
    const files = filesUnder(unpacked);
    for (const file of files) {
      const name = path.basename(file);
      if (name === SERVER || LIBRARY.test(name) || /^LICENSE/i.test(name)) fs.cpSync(file, path.join(staged, name), { verbatimSymlinks: true });
    }
    const specs = files.map((file) => path.dirname(file)).find((dir) => path.basename(dir) === 'model_specs');
    if (specs) fs.cpSync(specs, path.join(staged, 'model_specs'), { recursive: true });
    if (!fs.existsSync(path.join(staged, SERVER))) throw new Error(`${assetName} holds no ${SERVER}.`);
    markExecutable(path.join(staged, SERVER));
    fs.writeFileSync(path.join(staged, 'BUILD_INFO.txt'), [
      'engine=audio', `repo=https://github.com/${REPO}`, `release=${tag}`, `backend=${backend}`,
      `platform=${process.platform}`, `arch=${process.arch}`, `source=${asset.browser_download_url}`, ''
    ].join('\n'));

    emit(95, 'finalizing');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staged, target);
    emit(100, 'complete');
    return { version: tag, path: path.join(target, SERVER) };
  } finally {
    for (const leftover of [archive, unpacked, staged]) fs.rmSync(leftover, { recursive: true, force: true });
  }
}
