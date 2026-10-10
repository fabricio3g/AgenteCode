/**
 * A design's workspace: a folder under app data that the Design agent can read
 * and write, and nothing else on the machine. Every path that reaches disk
 * goes through {@link resolveInside}; the renderer and the model are never
 * trusted to have done it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESIGN_ENTRY, DESIGN_IMAGE_EXTENSIONS, DESIGN_LIMITS, DESIGN_TEXT_EXTENSIONS, DESIGN_VARIANTS_DIR,
  DESIGN_VERSIONS_DIR, type DesignFileEntry, type DesignFiles, type DesignVariant, type DesignVersion
} from '../../shared/design.ts';

export class DesignPathError extends Error {}

const CHAT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const textExt = new Set<string>(DESIGN_TEXT_EXTENSIONS);
const imageExt = new Set<string>(DESIGN_IMAGE_EXTENSIONS);
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };

const extOf = (file: string) => path.extname(file).slice(1).toLowerCase();

/** `<base>/<chatId>`; a chat id is an opaque token, never a path. */
export function workspaceRoot(base: string, chatId: unknown): string {
  if (typeof chatId !== 'string' || !CHAT_ID.test(chatId)) throw new DesignPathError('Invalid design id.');
  return path.join(base, chatId);
}

/** Create the workspace and return its real path (symlinked app-data folders resolve once, here). */
export function ensureWorkspace(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  return fs.realpathSync(root);
}

const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

/**
 * Turn a model-supplied relative path into an absolute one inside `root`.
 * Rejects NUL bytes, absolute and drive paths, `..` segments, the versions
 * folder, and any route through a symlink — including to a target that does
 * not exist yet, where the deepest existing ancestor is what gets checked.
 */
export function resolveInside(root: string, rel: unknown, options: { allowVersions?: boolean } = {}): string {
  if (typeof rel !== 'string' || !rel.trim()) throw new DesignPathError('A path is required.');
  if (rel.includes('\0')) throw new DesignPathError('Path contains a NUL byte.');
  const normalized = rel.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.startsWith('~') || /^[a-zA-Z]:/.test(normalized)) {
    throw new DesignPathError('Use a path relative to the design workspace.');
  }
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
  if (!segments.length) throw new DesignPathError('A path is required.');
  if (segments.includes('..')) throw new DesignPathError('Paths cannot leave the design workspace.');
  if (!options.allowVersions && segments[0] === DESIGN_VERSIONS_DIR) throw new DesignPathError('Version snapshots are managed by the app.');

  const realRoot = fs.realpathSync(root);
  const target = path.join(realRoot, ...segments);
  if (!inside(realRoot, target)) throw new DesignPathError('Paths cannot leave the design workspace.');

  // Walk the chain: no component may be a symlink, wherever it points.
  let current = realRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch { break; }
    if (stat.isSymbolicLink()) throw new DesignPathError('Symbolic links are not allowed in the design workspace.');
  }
  // Belt and braces: the real path of what exists must still be inside.
  let probe = target;
  while (!fs.existsSync(probe) && probe !== realRoot) probe = path.dirname(probe);
  if (!inside(realRoot, fs.realpathSync(probe))) throw new DesignPathError('Paths cannot leave the design workspace.');
  return target;
}

const relOf = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');

/** Every regular file in the workspace, versions excluded; symlinks are skipped, never followed. */
export function listFiles(root: string): DesignFileEntry[] {
  const out: DesignFileEntry[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (dir === root && entry.name === DESIGN_VERSIONS_DIR) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ path: relOf(root, full), size: fs.statSync(full).size });
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function assertWritable(root: string, file: string, bytes: number) {
  const ext = extOf(file);
  if (!textExt.has(ext)) throw new DesignPathError(`Only ${DESIGN_TEXT_EXTENSIONS.join(', ')} files can be written (got ".${ext || 'none'}").`);
  if (bytes > DESIGN_LIMITS.fileBytes) throw new DesignPathError(`File is too large (${bytes} bytes; the limit is ${DESIGN_LIMITS.fileBytes}).`);
  const existing = listFiles(root);
  const rel = relOf(root, file);
  const others = existing.filter((entry) => entry.path !== rel);
  if (others.length >= DESIGN_LIMITS.files) throw new DesignPathError('The workspace has reached its file limit.');
  if (others.reduce((sum, entry) => sum + entry.size, 0) + bytes > DESIGN_LIMITS.totalBytes) throw new DesignPathError('The workspace has reached its size limit.');
}

export function readText(root: string, rel: unknown): string {
  const file = resolveInside(root, rel);
  if (!textExt.has(extOf(file))) throw new DesignPathError('Only text files can be read; images are viewed with design_preview.');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new DesignPathError(`No such file: ${String(rel)}`);
  return fs.readFileSync(file, 'utf8');
}

export function writeText(root: string, rel: string, content: unknown): string {
  if (typeof content !== 'string') throw new DesignPathError('content must be a string.');
  const file = resolveInside(root, rel);
  assertWritable(root, file, Buffer.byteLength(content));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Re-check after the mkdir: a directory we just created cannot be a symlink, but a race could have made one.
  resolveInside(root, rel);
  fs.writeFileSync(file, content, 'utf8');
  return relOf(root, file);
}

export function editText(root: string, rel: string, oldText: unknown, newText: unknown, replaceAll = false): { path: string; replaced: number } {
  if (typeof oldText !== 'string' || typeof newText !== 'string' || !oldText) throw new DesignPathError('old_text and new_text are required.');
  const current = readText(root, rel);
  const count = current.split(oldText).length - 1;
  if (!count) throw new DesignPathError('old_text was not found. Read the file again and copy the text exactly.');
  if (count > 1 && !replaceAll) throw new DesignPathError(`old_text matches ${count} times. Add surrounding context or set replace_all.`);
  const next = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, () => newText);
  return { path: writeText(root, rel, next), replaced: replaceAll ? count : 1 };
}

/** What the canvas needs: text verbatim, images as data URLs, plus the page and variant lists. */
export function collectFiles(root: string): DesignFiles {
  const files: Record<string, string> = {};
  for (const entry of listFiles(root)) {
    const ext = extOf(entry.path);
    const full = path.join(root, entry.path);
    if (textExt.has(ext) && entry.size <= DESIGN_LIMITS.fileBytes) files[entry.path] = fs.readFileSync(full, 'utf8');
    else if (imageExt.has(ext) && entry.size <= 4 * 1024 * 1024) files[entry.path] = `data:${IMAGE_MIME[ext]};base64,${fs.readFileSync(full).toString('base64')}`;
  }
  const html = Object.keys(files).filter((file) => /\.html?$/i.test(file));
  const pages = html.filter((file) => !file.startsWith(`${DESIGN_VARIANTS_DIR}/`));
  pages.sort((a, b) => (a === DESIGN_ENTRY ? -1 : b === DESIGN_ENTRY ? 1 : a.localeCompare(b)));
  const variants: DesignVariant[] = [];
  for (const file of html) {
    const match = file.match(new RegExp(`^${DESIGN_VARIANTS_DIR}/([^/]+)/${DESIGN_ENTRY}$`));
    if (match) variants.push({ name: match[1], entry: file });
  }
  return { files, pages, variants };
}

// ── Versions ─────────────────────────────────────────────────────────

const versionsDir = (root: string) => path.join(root, DESIGN_VERSIONS_DIR);
const versionDir = (root: string, id: number) => path.join(versionsDir(root), String(id).padStart(4, '0'));
type VersionMeta = DesignVersion & { hashes: Record<string, string> };

function hashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of listFiles(root)) out[entry.path] = createHash('sha1').update(fs.readFileSync(path.join(root, entry.path))).digest('hex');
  return out;
}
const sameHashes = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

function readMeta(root: string): VersionMeta[] {
  const dir = versionsDir(root);
  if (!fs.existsSync(dir)) return [];
  const metas: VersionMeta[] = [];
  for (const name of fs.readdirSync(dir)) {
    try { metas.push(JSON.parse(fs.readFileSync(path.join(dir, name, 'meta.json'), 'utf8')) as VersionMeta); } catch { /* a half-written snapshot is skipped */ }
  }
  return metas.sort((a, b) => a.id - b.id);
}

export function listVersions(root: string): DesignVersion[] {
  return readMeta(root).map(({ hashes: _hashes, ...version }) => version).reverse();
}

/** Save the workspace as a version. Returns null when nothing changed since the last one. */
export function snapshot(root: string, label = '', auto = false): DesignVersion | null {
  const current = hashes(root);
  if (!Object.keys(current).length) return null;
  const metas = readMeta(root);
  const last = metas.at(-1);
  if (last && sameHashes(last.hashes, current)) return null;
  const id = (last?.id ?? 0) + 1;
  const dir = versionDir(root, id);
  for (const file of Object.keys(current)) {
    const target = path.join(dir, 'files', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  const meta: VersionMeta = { id, createdAt: Date.now(), label: label.slice(0, 80), auto, files: Object.keys(current).length, hashes: current };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  for (const old of metas.slice(0, Math.max(0, metas.length + 1 - DESIGN_LIMITS.versions))) fs.rmSync(versionDir(root, old.id), { recursive: true, force: true });
  const { hashes: _hashes, ...version } = meta;
  return version;
}

/** Put a version back. The current state is saved first, so a restore can itself be undone. */
export function restore(root: string, id: number): { restored: number; before: DesignVersion | null; paths: string[] } {
  const meta = readMeta(root).find((item) => item.id === id);
  if (!meta) throw new DesignPathError(`No version ${id}.`);
  const before = snapshot(root, `before restoring v${id}`, true);
  const paths = new Set([...listFiles(root).map((entry) => entry.path), ...Object.keys(meta.hashes)]);
  for (const entry of listFiles(root)) fs.rmSync(path.join(root, entry.path), { force: true });
  pruneEmptyDirs(root);
  const source = path.join(versionDir(root, id), 'files');
  for (const file of Object.keys(meta.hashes)) {
    const target = resolveInside(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, file), target);
  }
  return { restored: id, before, paths: [...paths] };
}

function pruneEmptyDirs(dir: string, top = true) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || (top && entry.name === DESIGN_VERSIONS_DIR)) continue;
    const full = path.join(dir, entry.name);
    pruneEmptyDirs(full, false);
    if (!fs.readdirSync(full).length) fs.rmdirSync(full);
  }
}

// ── Variants ─────────────────────────────────────────────────────────

/** Variants link `../../tokens.css` so they share the design's tokens; promoting moves them up two levels. */
const upLevels = (text: string) => text.replace(/(["'(=])\.\.\/\.\.\//g, '$1');

/**
 * Make a variant the design: its files replace the top-level pages, with the
 * `../../` prefix removed. The current design is saved first.
 */
export function promoteVariant(root: string, name: string): { before: DesignVersion | null; paths: string[] } {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(name)) throw new DesignPathError('Invalid variant name.');
  const dir = resolveInside(root, `${DESIGN_VARIANTS_DIR}/${name}`);
  if (!fs.existsSync(path.join(dir, DESIGN_ENTRY))) throw new DesignPathError(`Variant "${name}" has no ${DESIGN_ENTRY}.`);
  const before = snapshot(root, `before promoting ${name}`, true);
  const paths: string[] = [];
  const copy = (from: string, rel = '') => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { copy(path.join(from, entry.name), relPath); continue; }
      if (!entry.isFile()) continue;
      const ext = extOf(entry.name);
      const target = resolveInside(root, relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (/^(html?|css|svg)$/.test(ext)) fs.writeFileSync(target, upLevels(fs.readFileSync(path.join(from, entry.name), 'utf8')), 'utf8');
      else fs.copyFileSync(path.join(from, entry.name), target);
      paths.push(relPath);
    }
  };
  copy(dir);
  return { before, paths };
}

/** The file name an export gets: "pricing.html", or the variant's folder for "variants/bold/index.html". */
export function exportFileName(page: string): string {
  const parts = page.split('/').filter(Boolean);
  const file = parts[parts.length - 1] ?? '';
  const stem = file === DESIGN_ENTRY && parts.length > 1 ? parts[parts.length - 2] : path.basename(file, path.extname(file));
  const safe = stem.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe || 'design'}.html`;
}

/** Exports are whole documents; a page past this size is a mistake, not a design. */
export const EXPORT_MAX_BYTES = 8 * 1024 * 1024;

export function checkExportHtml(html: unknown): string {
  if (typeof html !== 'string' || !html.trim()) throw new DesignPathError('Nothing to export.');
  if (Buffer.byteLength(html, 'utf8') > EXPORT_MAX_BYTES) throw new DesignPathError('The page is too large to export.');
  return html;
}
