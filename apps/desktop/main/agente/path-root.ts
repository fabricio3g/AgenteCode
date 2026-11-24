import fs from 'node:fs';
import path from 'node:path';

function realpathOfNearestExistingAncestor(target: string): string {
  const parts: string[] = [];
  let cursor = path.resolve(target);
  while (true) {
    try {
      const real = fs.realpathSync(cursor);
      return parts.length ? path.join(real, ...parts.reverse()) : real;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(target);
      parts.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** `relative` resolved inside `projectRoot`; throws when it points outside (including via symlinks). */
export function resolveInRoot(projectRoot: string, relative: string): string {
  const root = realpathOfNearestExistingAncestor(projectRoot);
  const candidate = path.isAbsolute(relative) ? path.resolve(relative) : path.resolve(root, relative);
  const abs = realpathOfNearestExistingAncestor(candidate);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${relative}" escapes the project root`);
  }
  return abs;
}
