import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './paths.ts';
import { downloadToFile, extractArchive, resetDirectory, markExecutable } from './archive-install.ts';

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

  resetDirectory(destDir);
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
      await downloadToFile(item.url, archivePath, (fraction) => {
        emit(Math.round(item.start + fraction * item.span * 0.9), 'downloading');
      });
      emit(Math.round(item.start + item.span * 0.9), 'extracting');
      await extractArchive(item.name, archivePath, destDir, 'runtime');
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
          serverPath = markExecutable(full);
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
