import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import * as tar from 'tar';
import extract from 'extract-zip';
import { getAppPaths } from './paths.ts';

const isWindows = process.platform === 'win32';
const WHISPER_BINARIES = isWindows
  ? ['whisper-cli.exe', 'whisper.exe', 'main.exe']
  : ['whisper-cli', 'whisper', 'main'];

export async function downloadWhisperRuntime(
  { download_url, asset_name, release_tag }: { download_url: string; asset_name: string; release_tag: string },
  win: BrowserWindow | null = null
): Promise<{ success: boolean; runtime_id: string; path: string }> {
  const paths = getAppPaths();
  const destDir = path.join(
    paths.whisperBinVersionsRoot,
    `${release_tag}-${asset_name.replace(/\.(zip|tar\.gz|tgz)$/, '')}`
  );

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  function emit(progress: number, phase: string) {
    try { win?.webContents?.send('whisper-runtime-download-progress', { progress, phase }); } catch { /* ignore */ }
  }

  emit(0, 'downloading');

  const resp = await fetch(download_url);
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);

  const totalBytes = Number(resp.headers.get('content-length') || 0);
  const archivePath = path.join(paths.cacheRoot, asset_name);
  fs.mkdirSync(paths.cacheRoot, { recursive: true });

  const writeStream = fs.createWriteStream(archivePath);
  let downloaded = 0;
  const reader = resp.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writeStream.write(Buffer.from(value));
    downloaded += value.length;
    if (totalBytes > 0) {
      emit(Math.round((downloaded / totalBytes) * 80), 'downloading');
    }
  }
  await new Promise((res, rej) => writeStream.end(err => err ? rej(err) : res()));

  emit(80, 'extracting');

  const ensureSafeEntryPath = (entryPath: string) => {
    const normalized = path.normalize(String(entryPath || ''));
    if (!normalized || path.isAbsolute(normalized)) {
      throw new Error(`Unsafe archive entry path: ${entryPath}`);
    }
    if (normalized.split(path.sep).includes('..')) {
      throw new Error(`Unsafe archive entry path: ${entryPath}`);
    }
  };

  if (asset_name.endsWith('.tar.gz') || asset_name.endsWith('.tgz')) {
    await tar.x({
      file: archivePath,
      cwd: destDir,
      strict: false,
      preservePaths: false,
      filter: (entryPath: string) => {
        ensureSafeEntryPath(entryPath);
        return true;
      },
    });
  } else if (asset_name.endsWith('.zip')) {
    await extract(archivePath, {
      dir: destDir,
      onEntry: (entry: { fileName: string }) => ensureSafeEntryPath(entry.fileName),
    });
  } else {
    throw new Error(`Unsupported whisper runtime archive format: ${asset_name}`);
  }

  emit(95, 'finalizing');

  let binaryPath = '';
  function findBinary(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        findBinary(full);
      } else if (WHISPER_BINARIES.includes(e.name) && !binaryPath) {
        binaryPath = full;
        if (process.platform !== 'win32') fs.chmodSync(full, 0o755);
      }
    }
  }
  findBinary(destDir);

  fs.unlinkSync(archivePath);

  emit(100, 'complete');

  const runtimeId = path.basename(destDir);
  return {
    success: !!binaryPath,
    runtime_id: runtimeId,
    path: binaryPath,
  };
}
