// Shared primitives for "download an archive and unpack it into a versioned
// directory" — used by the llama.cpp runtime installer and the whisper.cpp
// runtime installer.
//
// The archive entry guard lives here rather than in each caller on purpose:
// both installers unpack archives fetched from a network release API, and a
// guard that exists twice is a guard that gets patched once.

import fs from 'node:fs';
import path from 'node:path';
import extract from 'extract-zip';
import * as tar from 'tar';

/**
 * Rejects an archive entry that would write outside the destination directory
 * (absolute paths and `..` traversal). Throws rather than returns so callers
 * cannot ignore the result.
 */
export function ensureSafeEntryPath(entryPath: string): void {
  const raw = String(entryPath ?? '');
  if (!raw.trim()) {
    throw new Error(`Unsafe archive entry path: ${entryPath}`);
  }
  // Normalizing first collapses `a/../b`, but it also turns '' into '.', so the
  // empty check has to read the raw value. `.` itself stays legal: archives
  // commonly carry a './' root entry.
  const normalized = path.normalize(raw);
  if (path.isAbsolute(normalized)) {
    throw new Error(`Unsafe archive entry path: ${entryPath}`);
  }
  if (normalized.split(path.sep).includes('..')) {
    throw new Error(`Unsafe archive entry path: ${entryPath}`);
  }
}

/** Streams `url` to `filePath`, reporting completion as a 0..1 fraction. */
export async function downloadToFile(
  url: string,
  filePath: string,
  onFraction: (fraction: number) => void = () => {}
): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);

  const totalBytes = Number(resp.headers.get('content-length') || 0);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const writeStream = fs.createWriteStream(filePath);
  let downloaded = 0;
  const reader = resp.body!.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writeStream.write(Buffer.from(value));
    downloaded += value.length;
    if (totalBytes > 0) onFraction(downloaded / totalBytes);
  }
  await new Promise((res, rej) => writeStream.end((err?: Error | null) => (err ? rej(err) : res())));
}

/**
 * Unpacks a .tar.gz/.tgz/.zip archive into `destDir`, rejecting unsafe entries.
 * `kind` only labels the "unsupported format" error (e.g. "runtime", "whisper runtime").
 */
export async function extractArchive(
  assetName: string,
  archivePath: string,
  destDir: string,
  kind = 'archive'
): Promise<void> {
  if (assetName.endsWith('.tar.gz') || assetName.endsWith('.tgz')) {
    await tar.x({
      file: archivePath,
      cwd: destDir,
      strict: false,
      preservePaths: false,
      filter: (entryPath: string) => {
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
    throw new Error(`Unsupported ${kind} archive format: ${assetName}`);
  }
}

/** Recreates `dir` empty, so a re-download cannot mix files from two releases. */
export function resetDirectory(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Makes a native binary executable and returns its path, so a freshly
 * unpacked runtime can be spawned on POSIX. Windows needs no chmod.
 */
export function markExecutable(binaryPath: string): string {
  if (process.platform !== 'win32') fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}
