import fs from 'node:fs';
import path from 'node:path';
import extract from 'extract-zip';
import * as tar from 'tar';
import { getAppPaths } from './paths.ts';

function ensureSafeEntryPath(entryPath) {
  const normalized = path.normalize(String(entryPath || ''));
  if (!normalized || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe archive entry path: ${entryPath}`);
  }
  if (normalized.split(path.sep).includes('..')) {
    throw new Error(`Unsafe archive entry path: ${entryPath}`);
  }
}

async function downloadArchive(downloadUrl, archivePath, onProgress) {
  const resp = await fetch(downloadUrl);
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);

  const totalBytes = Number(resp.headers.get('content-length') || 0);
  const writeStream = fs.createWriteStream(archivePath);
  let downloaded = 0;
  const reader = resp.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writeStream.write(Buffer.from(value));
    downloaded += value.length;
    if (totalBytes > 0) onProgress(downloaded / totalBytes);
  }
  await new Promise((res, rej) => writeStream.end(err => err ? rej(err) : res()));
}

async function extractArchive(assetName, archivePath, destDir) {
  if (assetName.endsWith('.tar.gz') || assetName.endsWith('.tgz')) {
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
  } else if (assetName.endsWith('.zip')) {
    await extract(archivePath, {
      dir: destDir,
      onEntry: (entry) => ensureSafeEntryPath(entry.fileName)
    });
  } else {
    throw new Error(`Unsupported runtime archive format: ${assetName}`);
  }
}

/**
 * Downloads and installs a llama.cpp runtime archive.
 *
 * `companions` are extracted into the same directory as the runtime. Windows
 * CUDA builds need this: they link against the CUDA runtime shipped in a
 * separate `cudart-*` asset, and without those DLLs beside llama-server.exe
 * the process fails to start.
 */
export async function downloadRuntime({ download_url, asset_name, release_tag, companions = [] }, win = null) {
  const paths = getAppPaths();
  const destDir = path.join(paths.localBinVersionsRoot, `${release_tag}-${asset_name.replace(/\.(zip|tar\.gz|tgz)$/, '')}`);

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(paths.cacheRoot, { recursive: true });

  function emit(progress, phase) {
    try { win?.webContents?.send('runtime-download-progress', { progress, phase }); } catch { /* ignore */ }
  }

  emit(0, 'downloading');

  // The runtime archive owns 0-75%, companions share 75-95%.
  const downloads = [
    { url: download_url, name: asset_name, start: 0, span: 75 },
    ...companions.map((companion, index) => ({
      url: companion.download_url,
      name: companion.asset_name,
      start: 75 + (index * 20) / companions.length,
      span: 20 / companions.length
    }))
  ];

  const archivePaths = [];
  try {
    for (const item of downloads) {
      const archivePath = path.join(paths.cacheRoot, item.name);
      archivePaths.push({ archivePath, name: item.name });
      await downloadArchive(item.url, archivePath, (fraction) => {
        emit(Math.round(item.start + fraction * item.span * 0.9), 'downloading');
      });
      emit(Math.round(item.start + item.span * 0.9), 'extracting');
      await extractArchive(item.name, archivePath, destDir);
    }

    emit(95, 'finalizing');

    let serverPath = '';
    function findBinary(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          findBinary(full);
        } else if (e.name === 'llama-server' || e.name === 'llama-server.exe') {
          serverPath = full;
          if (process.platform !== 'win32') fs.chmodSync(full, 0o755);
        }
      }
    }
    findBinary(destDir);

    emit(100, 'complete');

    return {
      success: !!serverPath,
      runtime_id: path.basename(destDir),
      path: serverPath
    };
  } finally {
    for (const { archivePath } of archivePaths) {
      try { fs.unlinkSync(archivePath); } catch { /* already gone */ }
    }
  }
}
