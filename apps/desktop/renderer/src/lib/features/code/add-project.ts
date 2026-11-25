// The Add project dialog's small decisions, kept pure: where a new project
// goes by default, how a path reads with the home folder shortened, and the
// path a new or cloned project will land at.

import type { FolderListing } from '$lib/services/files';

/** Where new and cloned projects go; remembered per viewer. */
export const PROJECTS_ROOT_KEY = 'agente.code.projectsRoot';

/** Folders that usually hold someone's projects, best first. */
const USUAL_ROOTS = ['Code', 'code', 'Projects', 'projects', 'repos', 'src', 'dev', 'workspace'];

/** The remembered projects folder, else a usual one in home, else home. */
export function defaultProjectsRoot(listing: Pick<FolderListing, 'home' | 'places'>, remembered?: string | null): string {
  if (remembered) return remembered;
  for (const name of USUAL_ROOTS) {
    const place = listing.places.find((candidate) => candidate.name === name);
    if (place) return place.path;
  }
  return listing.home;
}

/** `/home/me/Code/app` → `~/Code/app`; paths outside home stay whole. */
export function shortPath(path: string, home: string): string {
  if (!home || !path) return path;
  const lower = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const p = lower(path);
  const h = lower(home);
  if (p === h) return '~';
  if (p.startsWith(`${h}/`)) return `~${path.slice(home.replace(/[\\/]+$/, '').length).replace(/\\/g, '/')}`;
  return path;
}

/** `<parent>/<name>` with the parent's own separator. */
export function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${sep}${name.trim()}`;
}

export function readRemembered(): string | null {
  try {
    return localStorage.getItem(PROJECTS_ROOT_KEY);
  } catch {
    return null;
  }
}

export function remember(root: string): void {
  try {
    localStorage.setItem(PROJECTS_ROOT_KEY, root);
  } catch {
    // Remembering is a convenience; the dialog works without it.
  }
}
