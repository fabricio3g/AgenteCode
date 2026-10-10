/**
 * Handoff: the files a developer or the Code agent builds from. This module
 * owns the disk side (the bundle zip and the copy into a project's
 * `.agente/designs/`) with no Electron imports, so its spec runs under node.
 * The save dialog and the IPC wiring live in `ipc/design-handlers.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { DesignPathError, EXPORT_MAX_BYTES, exportFileName, listFiles } from './workspace.ts';

export const HANDOFF_FILE = 'HANDOFF.md';
/** The HANDOFF.md document: a generated summary, kept well under a megabyte. */
export const HANDOFF_MAX_BYTES = 512 * 1024;
/** Pages in one bundle (top-level pages plus variants). */
export const HANDOFF_MAX_PAGES = 40;
/** Where a project keeps handed-off designs. */
export const PROJECT_DESIGN_DIRS = ['.agente', 'designs'] as const;
const SLUG_MAX = 48;

export interface HandoffPage { name: string; html: string }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Validates the markdown document a request carries. */
export function checkHandoffText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new DesignPathError('There is no handoff document to send.');
  if (Buffer.byteLength(value, 'utf8') > HANDOFF_MAX_BYTES) throw new DesignPathError('The handoff document is too large.');
  return value;
}

/**
 * Validates the single-file pages of a bundle. Names are reduced to a safe
 * `<name>.html` and made unique; the HTML itself is capped like an export.
 */
export function checkHandoffPages(value: unknown): HandoffPage[] {
  if (!Array.isArray(value)) throw new DesignPathError('Pages must be a list.');
  if (value.length > HANDOFF_MAX_PAGES) throw new DesignPathError(`A bundle holds at most ${HANDOFF_MAX_PAGES} pages.`);
  const taken = new Set<string>();
  return value.map((item) => {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.html !== 'string') throw new DesignPathError('Each page needs a name and its HTML.');
    if (!item.html.trim()) throw new DesignPathError('A page has no HTML to bundle.');
    if (Buffer.byteLength(item.html, 'utf8') > EXPORT_MAX_BYTES) throw new DesignPathError('A page is too large to bundle.');
    const base = exportFileName(item.name).replace(/\.html$/, '');
    let name = `${base}.html`;
    for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}.html`;
    taken.add(name);
    return { name, html: item.html };
  });
}

/** A URL- and folder-safe name from a design title: "Pricing page!" → "pricing-page". */
export function slugify(title: unknown): string {
  const text = typeof title === 'string' ? title : '';
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug || 'design';
}

/**
 * The workspace as a zip: every file (versions excluded), the handoff
 * document, and each page inlined into one self-contained HTML file.
 */
export async function buildHandoffBundle(root: string, handoff: string, pages: HandoffPage[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const entry of listFiles(root)) zip.file(entry.path, fs.readFileSync(path.join(root, entry.path)));
  zip.file(HANDOFF_FILE, handoff);
  for (const page of pages) zip.file(`single-file/${page.name}`, page.html);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export interface DeliveredDesign { slug: string; dir: string; files: number }

/** Makes sure `<project>/.agente/designs` exists as plain folders; a symlink or file in the way is refused. */
function projectDesignsDir(projectRoot: unknown): string {
  if (typeof projectRoot !== 'string' || !projectRoot.trim() || projectRoot.includes('\0') || !path.isAbsolute(projectRoot)) {
    throw new DesignPathError('Choose a project folder first.');
  }
  let realProject: string;
  try {
    realProject = fs.realpathSync(projectRoot);
    if (!fs.statSync(realProject).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new DesignPathError('The project folder does not exist.');
  }
  let current = realProject;
  for (const segment of PROJECT_DESIGN_DIRS) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new DesignPathError(`${segment} in the project is not a plain folder.`);
    if (!stat) fs.mkdirSync(current);
  }
  return current;
}

/**
 * Copy the design into `<project>/.agente/designs/<slug>/` with its
 * HANDOFF.md. A slug that is taken gets -2, -3, … so an existing handoff is
 * never overwritten. The caller must have the user's confirmation first.
 */
export function deliverToProject(root: string, projectRoot: unknown, title: unknown, handoff: string): DeliveredDesign {
  const designs = projectDesignsDir(projectRoot);
  const base = slugify(title);
  let slug = base;
  let dir = path.join(designs, slug);
  for (let n = 2; ; n += 1) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (n > 999) throw new DesignPathError('Too many designs with this name in the project.');
      slug = `${base}-${n}`;
      dir = path.join(designs, slug);
    }
  }
  try {
    let files = 0;
    for (const entry of listFiles(root)) {
      const target = path.join(dir, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, entry.path), target);
      files += 1;
    }
    fs.writeFileSync(path.join(dir, HANDOFF_FILE), handoff, 'utf8');
    return { slug, dir, files };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
