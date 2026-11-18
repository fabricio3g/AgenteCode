/**
 * Design systems: reusable folders of tokens, guidance and an optional specimen
 * page, kept under app data so any design can start from one. A design is
 * linked to its system by a small file beside its workspace (`<chatId>.system.json`),
 * outside the folder the agent can list, so the link never appears in its files.
 * Every path goes through the workspace jail in workspace.ts; the import reads
 * a folder the user picked and only reads text, it never runs anything in it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESIGN_IMAGE_EXTENSIONS, DESIGN_SYSTEM_MANIFEST, DESIGN_SYSTEM_SPECIMEN, DESIGN_TEXT_EXTENSIONS,
  type DesignFiles, type DesignSystemBrief, type DesignSystemDetail, type DesignSystemRequest, type DesignSystemSummary, type DesignVersion
} from '../../shared/design.ts';
import { DesignPathError, collectFiles, ensureWorkspace, listFiles, resolveInside, snapshot, workspaceRoot, writeText } from './workspace.ts';

export interface DesignSystemHost {
  /** `<app data>/design-systems`: one folder per system. */
  systemsRoot: string;
  /** `<app data>/designs`: one workspace per design, plus the link files. */
  designsRoot: string;
  /** Tells the canvas that a design's files changed. */
  changed(chatId: string, paths: string[]): void;
  /** Asks the user for a folder; null when they cancel. */
  pickFolder(): Promise<string | null>;
}

interface Manifest {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  origin: 'design' | 'folder';
}

const ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const textExt = new Set<string>(DESIGN_TEXT_EXTENSIONS);
const imageExt = new Set<string>(DESIGN_IMAGE_EXTENSIONS);
/** The files a system is made of at the top level; `assets/` rides along. */
const SYSTEM_FILES: readonly string[] = ['tokens.css', 'DESIGN.md', DESIGN_SYSTEM_SPECIMEN];
const isSystemFile = (rel: string) => SYSTEM_FILES.includes(rel) || rel.startsWith('assets/');
const extOf = (file: string) => path.extname(file).slice(1).toLowerCase();

/** Import limits: a project folder is scanned, not read in full. */
const IMPORT = {
  maxDepth: 3,
  maxEntries: 400,
  maxCssFiles: 40,
  maxFileBytes: 256 * 1024,
  maxConfigBytes: 64 * 1024,
  themeChars: 3000,
  maxProperties: 300
} as const;
const IMPORT_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage', 'vendor', '.next', '.agente', '.claude', '.versions']);

export function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new DesignPathError('A name is required.');
  return name.slice(0, 60);
}

const cleanDescription = (raw: unknown) => (typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 200) : '');

/** A link target is a generated slug; anything else is refused before it becomes a path. */
function checkedId(id: unknown): string {
  if (typeof id !== 'string' || !ID.test(id)) throw new DesignPathError('Unknown design system.');
  return id;
}

function systemDir(systemsRoot: string, id: unknown): string {
  const dir = path.join(systemsRoot, checkedId(id));
  if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) throw new DesignPathError('Unknown design system.');
  return dir;
}

function newSystemId(systemsRoot: string, name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'system';
  for (;;) {
    const id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    if (!fs.existsSync(path.join(systemsRoot, id))) return id;
  }
}

function readManifest(dir: string): Manifest | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, DESIGN_SYSTEM_MANIFEST), 'utf8')) as Manifest;
    return typeof manifest?.id === 'string' && typeof manifest.name === 'string' ? manifest : null;
  } catch {
    return null;
  }
}

function writeManifest(dir: string, manifest: Manifest) {
  fs.writeFileSync(path.join(dir, DESIGN_SYSTEM_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function summarize(dir: string, manifest: Manifest): DesignSystemSummary {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    origin: manifest.origin === 'folder' ? 'folder' : 'design',
    hasTokens: fs.existsSync(path.join(dir, 'tokens.css')),
    hasSpecimen: fs.existsSync(path.join(dir, DESIGN_SYSTEM_SPECIMEN))
  };
}

/** A file inside a folder we own, or null when it is not there. */
function readOptional(root: string, rel: string): string | null {
  const file = resolveInside(root, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return fs.readFileSync(file, 'utf8');
}

/** Copy one file between two folders, both through the jail. Binary-safe. */
function copyEntry(fromRoot: string, rel: string, toRoot: string) {
  const source = resolveInside(fromRoot, rel);
  const target = resolveInside(toRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

const linkFile = (designsRoot: string, chatId: string) => {
  workspaceRoot(designsRoot, chatId);
  return path.join(designsRoot, `${chatId}.system.json`);
};

function linkedId(designsRoot: string, chatId: string): string | null {
  try {
    const link = JSON.parse(fs.readFileSync(linkFile(designsRoot, chatId), 'utf8')) as { id?: unknown };
    return typeof link.id === 'string' && ID.test(link.id) ? link.id : null;
  } catch {
    return null;
  }
}

export function listSystems(systemsRoot: string): DesignSystemSummary[] {
  if (!fs.existsSync(systemsRoot)) return [];
  const out: DesignSystemSummary[] = [];
  for (const entry of fs.readdirSync(systemsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue;
    const dir = path.join(systemsRoot, entry.name);
    const manifest = readManifest(dir);
    if (manifest?.id === entry.name) out.push(summarize(dir, manifest));
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

export function getSystem(systemsRoot: string, id: unknown): DesignSystemDetail {
  const dir = systemDir(systemsRoot, id);
  const manifest = readManifest(dir);
  if (!manifest) throw new DesignPathError('Unknown design system.');
  const files: DesignFiles = collectFiles(dir);
  delete files.files[DESIGN_SYSTEM_MANIFEST];
  return { ...summarize(dir, manifest), files };
}

/**
 * Save a design's system files as a new system. The design must already have
 * tokens or guidance; a bare page is not a system.
 */
function createSystem(host: DesignSystemHost, chatId: string, name: unknown, description: unknown): DesignSystemSummary {
  const root = ensureWorkspace(workspaceRoot(host.designsRoot, chatId));
  const wanted = listFiles(root).map((entry) => entry.path).filter(isSystemFile);
  if (!SYSTEM_FILES.slice(0, 2).some((rel) => wanted.includes(rel))) {
    throw new DesignPathError('Nothing to save yet. Ask the agent for tokens.css or DESIGN.md first.');
  }
  const cleaned = cleanName(name);
  fs.mkdirSync(host.systemsRoot, { recursive: true });
  const id = newSystemId(host.systemsRoot, cleaned);
  const dir = path.join(host.systemsRoot, id);
  fs.mkdirSync(dir);
  try {
    for (const rel of wanted) copyEntry(root, rel, dir);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const now = Date.now();
  const manifest: Manifest = { id, name: cleaned, description: cleanDescription(description), createdAt: now, updatedAt: now, origin: 'design' };
  writeManifest(dir, manifest);
  return summarize(dir, manifest);
}

/**
 * A system made from text files rather than from a design: `design_reference`
 * builds one from a page's tokens. Only the system's own top-level files are
 * accepted, and every file goes through the same jail as a design's.
 */
export function createSystemFromFiles(systemsRoot: string, input: { name: unknown; description: unknown; files: Record<string, string> }): DesignSystemSummary {
  const cleaned = cleanName(input.name);
  const names = Object.keys(input.files);
  if (!names.length || names.some((rel) => !SYSTEM_FILES.includes(rel) || rel === DESIGN_SYSTEM_SPECIMEN)) {
    throw new DesignPathError('A system is made of tokens.css and DESIGN.md.');
  }
  fs.mkdirSync(systemsRoot, { recursive: true });
  const id = newSystemId(systemsRoot, cleaned);
  const dir = path.join(systemsRoot, id);
  fs.mkdirSync(dir);
  try {
    for (const rel of names) writeText(dir, rel, input.files[rel]);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const now = Date.now();
  const manifest: Manifest = { id, name: cleaned, description: cleanDescription(input.description), createdAt: now, updatedAt: now, origin: 'design' };
  writeManifest(dir, manifest);
  return summarize(dir, manifest);
}

function renameSystem(systemsRoot: string, id: unknown, name: unknown): DesignSystemSummary {
  const dir = systemDir(systemsRoot, id);
  const manifest = readManifest(dir);
  if (!manifest) throw new DesignPathError('Unknown design system.');
  const next: Manifest = { ...manifest, name: cleanName(name), updatedAt: Date.now() };
  writeManifest(dir, next);
  return summarize(dir, next);
}

function deleteSystem(systemsRoot: string, id: unknown): { deleted: true } {
  const dir = systemDir(systemsRoot, id);
  fs.rmSync(dir, { recursive: true, force: true });
  return { deleted: true };
}

/**
 * Copy the system's files into the design, overwriting same-named files. The
 * design is snapshotted first, so the whole change can be restored from its
 * version list. Returns the workspace paths that changed.
 */
function applySystem(host: DesignSystemHost, chatId: string, id: unknown): { before: DesignVersion | null; paths: string[] } {
  const root = ensureWorkspace(workspaceRoot(host.designsRoot, chatId));
  const dir = systemDir(host.systemsRoot, id);
  const manifest = readManifest(dir);
  if (!manifest) throw new DesignPathError('Unknown design system.');
  const before = snapshot(root, `before using ${manifest.name}`, true);
  const paths: string[] = [];
  for (const { path: rel } of listFiles(dir)) {
    if (!isSystemFile(rel)) continue;
    const ext = extOf(rel);
    if (textExt.has(ext)) writeText(root, rel, fs.readFileSync(resolveInside(dir, rel), 'utf8'));
    else if (imageExt.has(ext)) copyEntry(dir, rel, root);
    else continue;
    paths.push(rel);
  }
  fs.writeFileSync(linkFile(host.designsRoot, chatId), `${JSON.stringify({ id: manifest.id })}\n`, 'utf8');
  return { before, paths };
}

function unlinkSystem(designsRoot: string, chatId: string): { ok: true } {
  fs.rmSync(linkFile(designsRoot, chatId), { force: true });
  return { ok: true };
}

function currentSystem(systemsRoot: string, designsRoot: string, chatId: string): DesignSystemSummary | null {
  const id = linkedId(designsRoot, chatId);
  if (!id) return null;
  const dir = path.join(systemsRoot, id);
  const manifest = readManifest(dir);
  return manifest?.id === id ? summarize(dir, manifest) : null;
}

/** What the design agent reads about its system at the start of a turn. */
function briefSystem(systemsRoot: string, designsRoot: string, chatId: string): DesignSystemBrief | null {
  const id = linkedId(designsRoot, chatId);
  if (!id) return null;
  const dir = path.join(systemsRoot, id);
  const manifest = readManifest(dir);
  if (manifest?.id !== id) return null;
  return { name: manifest.name, designMd: readOptional(dir, 'DESIGN.md') ?? '', tokens: readOptional(dir, 'tokens.css') ?? '' };
}

// ── Import from a project folder ─────────────────────────────────────

export interface FolderTokens {
  /** tokens.css verbatim, or one generated from the custom properties the folder's stylesheets declare. */
  tokens?: string;
  /** DESIGN.md verbatim, or a short generated one; a tailwind theme excerpt is appended as reference. */
  designMd: string;
  /** How many custom properties were found in stylesheets. */
  properties: number;
}

/**
 * Read a project folder for design tokens. Breadth-first, so the shallowest
 * tokens.css or DESIGN.md wins. It only reads: stylesheets for custom
 * properties, a tailwind config as text. Nothing is executed or followed through links.
 */
export function scanFolderTokens(folder: string): FolderTokens {
  const readText = (file: string, max: number): string | undefined => {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() && stat.size <= max ? fs.readFileSync(file, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  };
  let tokens: string | undefined;
  let designMd: string | undefined;
  let tailwind: string | undefined;
  const stylesheets: string[] = [];
  let visited = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: folder, depth: 0 }];
  while (queue.length && visited < IMPORT.maxEntries) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > IMPORT.maxEntries) break;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < IMPORT.maxDepth && !IMPORT_SKIP.has(entry.name)) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower === 'tokens.css' && tokens === undefined) tokens = readText(full, IMPORT.maxFileBytes);
      else if (lower === 'design.md' && designMd === undefined) designMd = readText(full, IMPORT.maxFileBytes);
      else if (lower.endsWith('.css') && stylesheets.length < IMPORT.maxCssFiles) {
        const text = readText(full, IMPORT.maxFileBytes);
        if (text) stylesheets.push(text);
      } else if (/^tailwind\.config\.(c|m)?[jt]s$/.test(lower) && tailwind === undefined) {
        const text = readText(full, IMPORT.maxConfigBytes);
        if (text) {
          const at = Math.max(0, text.search(/\btheme\s*[:=]/));
          tailwind = text.slice(at, at + IMPORT.themeChars);
        }
      }
    }
  }

  const properties = new Map<string, string>();
  for (const css of stylesheets) {
    for (const match of css.matchAll(/(--[A-Za-z][\w-]*)\s*:\s*([^;{}]+?)\s*;/g)) {
      const [, name, value] = match;
      if (name.startsWith('--tw-') || properties.has(name) || properties.size >= IMPORT.maxProperties) continue;
      properties.set(name, value);
    }
  }
  const generated = properties.size
    ? `:root {\n${[...properties].map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}\n`
    : undefined;

  const parts = [designMd ?? `# ${path.basename(folder)}\n\nImported from a project folder. The tokens are the CSS custom properties its stylesheets declare.`];
  if (tailwind) parts.push(`## Tailwind theme (reference)\n\n\`\`\`js\n${tailwind.trimEnd()}\n\`\`\``);
  if (tokens === undefined && generated === undefined && designMd === undefined && tailwind === undefined) {
    throw new DesignPathError('No design tokens found in that folder. Looked for tokens.css, DESIGN.md, CSS custom properties and a tailwind config.');
  }
  return { tokens: tokens ?? generated, designMd: `${parts.join('\n\n')}\n`, properties: properties.size };
}

async function importFolder(host: DesignSystemHost): Promise<DesignSystemSummary | null> {
  const folder = await host.pickFolder();
  if (!folder) return null;
  const found = scanFolderTokens(folder);
  const name = cleanName(path.basename(folder) || 'Imported system');
  fs.mkdirSync(host.systemsRoot, { recursive: true });
  const id = newSystemId(host.systemsRoot, name);
  const dir = path.join(host.systemsRoot, id);
  fs.mkdirSync(dir);
  try {
    if (found.tokens !== undefined) fs.writeFileSync(path.join(dir, 'tokens.css'), found.tokens, 'utf8');
    fs.writeFileSync(path.join(dir, 'DESIGN.md'), found.designMd, 'utf8');
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const now = Date.now();
  const manifest: Manifest = { id, name, description: 'Imported from a project folder', createdAt: now, updatedAt: now, origin: 'folder' };
  writeManifest(dir, manifest);
  return summarize(dir, manifest);
}

/** The IPC surface: one entry point, one branch per action. Main decides everything; the renderer only names a system or a design. */
export async function runDesignSystemRequest(request: DesignSystemRequest, host: DesignSystemHost): Promise<unknown> {
  switch (request?.action) {
    case 'list': return listSystems(host.systemsRoot);
    case 'get': return getSystem(host.systemsRoot, request.id);
    case 'create': return createSystem(host, request.chatId, request.name, request.description);
    case 'rename': return renameSystem(host.systemsRoot, request.id, request.name);
    case 'delete': return deleteSystem(host.systemsRoot, request.id);
    case 'apply': {
      const result = applySystem(host, request.chatId, request.id);
      host.changed(request.chatId, result.paths);
      return result;
    }
    case 'unlink': return unlinkSystem(host.designsRoot, request.chatId);
    case 'current': return currentSystem(host.systemsRoot, host.designsRoot, request.chatId);
    case 'brief': return briefSystem(host.systemsRoot, host.designsRoot, request.chatId);
    case 'import': return importFolder(host);
    default: throw new DesignPathError('Unknown design system action.');
  }
}
