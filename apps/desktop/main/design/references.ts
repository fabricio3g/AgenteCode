/**
 * The `references/` folder of a design: images the user attached and screenshots
 * the agent saved from pages it read. Main writes every file here, after checking
 * the bytes (never the name) and the workspace limits; the agent reads them with
 * `design_view` through the same path jail as every other workspace file.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESIGN_LIMITS, DESIGN_REFERENCES_DIR, REFERENCE_IMAGE_MAX_BYTES, VIEW_IMAGE_MAX_BYTES,
  type DesignImageResult, type DesignReferenceAdded
} from '../../shared/design.ts';
import { nextReferenceName } from './reference-tokens.ts';
import { DesignPathError, listFiles, resolveInside } from './workspace.ts';

export interface SniffedImage { mimeType: string; ext: string }

const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));
const ascii = (bytes: Buffer, start: number, end: number) => bytes.subarray(start, end).toString('ascii');

/** The image type from its first bytes, or null when the bytes are not a known image. */
export function sniffImage(bytes: Buffer): SniffedImage | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mimeType: 'image/png', ext: 'png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: 'image/jpeg', ext: 'jpg' };
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return { mimeType: 'image/gif', ext: 'gif' };
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return { mimeType: 'image/webp', ext: 'webp' };
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(bytes, 8, 12))) return { mimeType: 'image/avif', ext: 'avif' };
  return null;
}

/** A user's file name as a safe stem: `Hero Shot (final).PNG` → `hero-shot-final`. */
export function referenceStemOf(name: unknown): string {
  const base = typeof name === 'string' ? path.posix.basename(name.replace(/\\/g, '/')) : '';
  const stem = base.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return stem || 'reference';
}

/** The file names directly inside `references/` (no folders, no paths). */
export function referenceFileNames(root: string): string[] {
  const prefix = `${DESIGN_REFERENCES_DIR}/`;
  return listFiles(root)
    .map((entry) => entry.path)
    .filter((rel) => rel.startsWith(prefix) && !rel.slice(prefix.length).includes('/'))
    .map((rel) => rel.slice(prefix.length));
}

/** Refuse a write that would pass the workspace's file or size limits. */
function assertRoomFor(root: string, bytes: number) {
  const files = listFiles(root);
  if (files.length >= DESIGN_LIMITS.files) throw new DesignPathError('The workspace has reached its file limit.');
  if (files.reduce((sum, entry) => sum + entry.size, 0) + bytes > DESIGN_LIMITS.totalBytes) throw new DesignPathError('The workspace has reached its size limit.');
}

/** Write one binary file through the jail; the parent folder is created, a symlink anywhere on the way is refused. */
function writeReference(root: string, rel: string, bytes: Buffer): void {
  assertRoomFor(root, bytes.length);
  const file = resolveInside(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Re-check after the mkdir, as writeText does: the folder we just made must still be ours.
  resolveInside(root, rel);
  fs.writeFileSync(file, bytes);
}

/**
 * Copy an attached image into `references/`. The same bytes are kept once (the
 * existing file is returned); a new image gets its file name, numbered when taken.
 */
export function addReference(root: string, name: unknown, data: unknown): DesignReferenceAdded {
  if (typeof data !== 'string' || !data.trim()) throw new DesignPathError('No image data.');
  const bytes = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!bytes.length) throw new DesignPathError('No image data.');
  if (bytes.length > REFERENCE_IMAGE_MAX_BYTES) throw new DesignPathError(`The image is too large (the limit is ${megabytes(REFERENCE_IMAGE_MAX_BYTES)} MB).`);
  const image = sniffImage(bytes);
  if (!image) throw new DesignPathError('Only PNG, JPEG, WebP, GIF and AVIF images can be added as references.');

  const digest = createHash('sha256').update(bytes).digest('hex');
  for (const file of referenceFileNames(root)) {
    const rel = `${DESIGN_REFERENCES_DIR}/${file}`;
    const existing = fs.readFileSync(resolveInside(root, rel));
    if (createHash('sha256').update(existing).digest('hex') === digest) return { path: rel, existed: true };
  }

  const stem = referenceStemOf(name);
  const taken = new Set(referenceFileNames(root));
  for (let n = 1; n < 1000; n++) {
    const file = `${n === 1 ? stem : `${stem}-${n}`}.${image.ext}`;
    if (!taken.has(file)) {
      const rel = `${DESIGN_REFERENCES_DIR}/${file}`;
      writeReference(root, rel, bytes);
      return { path: rel, existed: false };
    }
  }
  throw new DesignPathError('Too many references share this name.');
}

/**
 * Add an image the user chose in a file dialog. The size is checked before the
 * file is read, and the bytes (never the name) decide whether it is an image.
 */
export function addReferenceFile(root: string, file: string): DesignReferenceAdded {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new DesignPathError('Choose an image file.');
  if (stat.size > REFERENCE_IMAGE_MAX_BYTES) throw new DesignPathError(`The image is too large (the limit is ${megabytes(REFERENCE_IMAGE_MAX_BYTES)} MB).`);
  return addReference(root, path.basename(file), fs.readFileSync(file).toString('base64'));
}

/** Keep a screenshot the agent took of a page, named `<host>-<n>.png`. Returns the workspace path. */
export function saveReferenceScreenshot(root: string, stem: string, png: Buffer): string {
  const file = nextReferenceName(stem, referenceFileNames(root));
  const rel = `${DESIGN_REFERENCES_DIR}/${file}`;
  writeReference(root, rel, png);
  return rel;
}

/**
 * One image from the workspace, for `design_view`. Only `references/` and
 * `assets/` are readable, only real PNG/JPEG/WebP/GIF bytes, and only up to the
 * size a vision model takes in one piece.
 */
export function readReferenceImage(root: string, rel: unknown): DesignImageResult {
  if (typeof rel !== 'string' || !rel.trim()) throw new DesignPathError('A path is required.');
  const normal = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  const top = normal.split('/')[0];
  if (top !== DESIGN_REFERENCES_DIR && top !== 'assets') throw new DesignPathError('design_view reads images from references/ or assets/.');
  const file = resolveInside(root, normal);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new DesignPathError(`No such image: ${normal}`);
  const size = fs.statSync(file).size;
  if (size > VIEW_IMAGE_MAX_BYTES) throw new DesignPathError(`The image is too large to view (${Math.round(size / 1024)} KB; the limit is ${megabytes(VIEW_IMAGE_MAX_BYTES)} MB).`);
  const bytes = fs.readFileSync(file);
  const image = sniffImage(bytes);
  if (!image || image.ext === 'avif') throw new DesignPathError(`${normal} is not a PNG, JPEG, WebP or GIF image.`);
  return { path: normal, mimeType: image.mimeType, data: bytes.toString('base64'), bytes: bytes.length };
}

/** Delete one file directly inside `references/`; nothing else in the workspace can be removed this way. */
export function removeReference(root: string, rel: unknown): string {
  if (typeof rel !== 'string') throw new DesignPathError('A path is required.');
  const normal = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  const prefix = `${DESIGN_REFERENCES_DIR}/`;
  if (!normal.startsWith(prefix) || normal.slice(prefix.length).includes('/')) throw new DesignPathError('Only images in references/ can be removed.');
  const file = resolveInside(root, normal);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new DesignPathError(`No such image: ${normal}`);
  fs.unlinkSync(file);
  return normal;
}
