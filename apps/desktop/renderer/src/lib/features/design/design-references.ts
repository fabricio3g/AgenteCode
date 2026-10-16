/**
 * The reference images of a design, as the tray and the composer's briefing see
 * them. Main owns the folder and checks every byte; these helpers only read
 * names and decide what the user may type into the capture field.
 */
import { DESIGN_REFERENCES_DIR } from '$shared/design';

const IMAGE = /\.(png|jpe?g|webp|gif|avif)$/i;
const PREFIX = `${DESIGN_REFERENCES_DIR}/`;

/** A file directly inside `references/` with an image name. */
export function isReferencePath(path: string): boolean {
  return path.startsWith(PREFIX) && !path.slice(PREFIX.length).includes('/') && IMAGE.test(path);
}

/** The reference images among a workspace's file names, sorted. */
export function referencePaths(paths: readonly string[]): string[] {
  return paths.filter(isReferencePath).sort((a, b) => a.localeCompare(b));
}

/** What a reference is called on its thumbnail: `hero-shot.png` → `hero-shot`. */
export function referenceLabel(path: string): string {
  return path.slice(PREFIX.length).replace(/\.[^.]+$/, '');
}

/**
 * A typed address as a public URL: `stripe.com` gets https, anything else with a
 * scheme must be http(s). Null for what is plainly not a page address. Main still
 * decides whether the address may be loaded (no private networks, no credentials).
 */
export function normalizeSiteUrl(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const IMAGE_TYPE = /^image\/(png|jpeg|webp|gif|avif)$/;

/** The files of a drop or paste that are images main can take; everything else is left alone. */
export function imageFilesOf(files: ArrayLike<{ type: string }> | null | undefined): File[] {
  return Array.from((files ?? []) as ArrayLike<File>).filter((file) => IMAGE_TYPE.test(file.type));
}

/** A file's bytes as base64, for main to check and write. */
export function readFileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}
