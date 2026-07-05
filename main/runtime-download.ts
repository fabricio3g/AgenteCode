import fs from 'node:fs';
import path from 'node:path';
import extract from 'extract-zip';
import * as tar from 'tar';
import { getAppPaths } from './paths.ts';

export async function downloadRuntime({ download_url, asset_name, release_tag }, win = null) {
  const paths = getAppPaths();
  const destDir = path.join(paths.localBinVersionsRoot, `${release_tag}-${asset_name.replace(/\.(zip|tar\.gz|tgz)$/, '')}`);

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  function emit(progress, phase) {
    try { win?.webContents?.send('runtime-download-progress', { progress, phase }); } catch { /* ignore */ }
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

  const ensureSafeEntryPath = (entryPath) => {
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
      filter: (entryPath) => {
        ensureSafeEntryPath(entryPath);
        return true;
      }
    });
  } else if (asset_name.endsWith('.zip')) {
    await extract(archivePath, {
      dir: destDir,
      onEntry: (entry) => ensureSafeEntryPath(entry.fileName)
    });
  } else {
    throw new Error(`Unsupported runtime archive format: ${asset_name}`);
  }

  emit(95, 'finalizing');

  let serverPath = '';
  function findBinary(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        findBinary(full);
      } else if (e.name === 'llama-server' || e.name === 'llama-server.exe' || e.name === 'server') {
        serverPath = full;
        if (process.platform !== 'win32') fs.chmodSync(full, 0o755);
      }
    }
  }
  findBinary(destDir);

  fs.unlinkSync(archivePath);

  emit(100, 'complete');

  const runtimeId = path.basename(destDir);
  return {
    success: !!serverPath,
    runtime_id: runtimeId,
    path: serverPath
  };
}
