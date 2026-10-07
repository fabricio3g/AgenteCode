/**
 * Electron's own content-addressed attachment store.
 *
 * The TUI/CLI is a separate front end on the Rust core, and `agente-core`'s
 * `media.rs` owns *its* store (`~/.agente/attachments`, redirected by
 * `AGENTE_CONFIG_DIR`). Electron is a separate app: it keeps its copies under its
 * own app-data folder, next to the images it hands to the runtime. Nothing here
 * re-implements the core's layout, and the two stores are not interchangeable —
 * if they should ever share files, that belongs behind a core API rather than a
 * path convention written in TypeScript.
 *
 * Within this store a file's name is its content: `<sha256[:12]>.<ext>`, so the
 * same upload is kept once and a stored path stays valid after the composer's
 * temp copy is gone.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './paths.ts';

export function attachmentStoreDir(): string {
  return path.join(getAppPaths().appData, 'agente', 'attachments');
}

/** Full sha256 of a file's bytes — the registry's primary key. */
export function attachmentHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The stored name: the first twelve hex characters of the hash. */
export function storedName(hash: string, extension: string): string {
  const ext = String(extension || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${hash.slice(0, 12)}.${ext || 'bin'}`;
}

/**
 * The absolute path of a file that really is in the store, or null. Deleting a
 * registry row must never become a way to delete an arbitrary path, so the
 * caller only ever gets a path whose parent is the store itself.
 */
export function storedPathIn(pathname: string): string | null {
  const dir = path.resolve(attachmentStoreDir());
  const resolved = path.resolve(String(pathname || ''));
  return path.dirname(resolved) === dir ? resolved : null;
}

/**
 * Copies a file into the store once, and returns its full hash, stored path and
 * size. An already-stored file is left alone — the name is its content.
 */
export function storeAttachmentFile(filePath: string): { hash: string; storedPath: string; bytes: number } {
  const bytes = fs.readFileSync(filePath);
  const hash = attachmentHash(bytes);
  const dir = attachmentStoreDir();
  fs.mkdirSync(dir, { recursive: true });
  const storedPath = path.join(dir, storedName(hash, path.extname(filePath).replace(/^\./, '')));
  if (!fs.existsSync(storedPath)) {
    // Written beside the target and renamed, so a crash never leaves a partial
    // file under a content-addressed name.
    const temp = `${storedPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, storedPath);
  }
  return { hash, storedPath, bytes: bytes.length };
}
