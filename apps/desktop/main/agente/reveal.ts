// ── Showing a project file in the OS ───────────────────────────────────
// The explorer's "Reveal in folder" action (and the Files screen's trash). Like every other path that crosses
// this boundary it is resolved inside the project root first, so a crafted
// relative path cannot make the app open something outside the workspace.

import { shell } from 'electron';
import fs from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { resolveInRoot } from './changes.ts';

/**
 * Move a project file to the OS trash — the Files screen's delete. Never a hard
 * delete: the user can restore it from the trash.
 */
export async function trashPath(projectRoot: string, relative: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const abs = resolveInRoot(projectRoot, relative);
    if (abs === resolvePath(projectRoot)) throw new Error('Refusing to trash the project root');
    if (!fs.existsSync(abs)) return { ok: true };
    await shell.trashItem(abs);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export function revealPath(projectRoot: string, relative: string): { ok: boolean; error?: string } {
  try {
    const abs = resolveInRoot(projectRoot, relative);
    // A folder is opened itself; a file is shown selected in its parent.
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) void shell.openPath(abs);
    else shell.showItemInFolder(abs);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
