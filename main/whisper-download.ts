import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { getAppPaths } from './paths.ts';
import { downloadToFile, extractArchive, resetDirectory, markExecutable } from './archive-install.ts';

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

  resetDirectory(destDir);

  function emit(progress: number, phase: string) {
    try { win?.webContents?.send('whisper-runtime-download-progress', { progress, phase }); } catch { /* ignore */ }
  }

  emit(0, 'downloading');

  // Downloading owns 0-80%, extraction and finalizing the rest.
  const archivePath = path.join(paths.cacheRoot, asset_name);
  await downloadToFile(download_url, archivePath, (fraction) => {
    emit(Math.round(fraction * 80), 'downloading');
  });

  emit(80, 'extracting');
  await extractArchive(asset_name, archivePath, destDir, 'whisper runtime');

  emit(95, 'finalizing');

  let binaryPath = '';
  function findBinary(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        findBinary(full);
      } else if (WHISPER_BINARIES.includes(e.name) && !binaryPath) {
        binaryPath = markExecutable(full);
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
