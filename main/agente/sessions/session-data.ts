// ── Engine data lifecycle ──────────────────────────────────────────────
// A Code conversation leaves two things in app data: its session log
// (`sessions/<projectSlug>/<ts>-<id>.jsonl`) and its checkpoints
// (`checkpoints/<id>/`). Deleting a conversation or a whole project removes
// exactly those — never anything inside the user's project folder.

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Session ids are generated as `agente-<ts>-<hex>`; anything else is refused. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface SessionDataDirs {
  sessionsDir: string;
  checkpointsDir: string;
}

/**
 * Remove the logs and checkpoints of the given sessions. Returns how many
 * sessions had something removed. Unknown or malformed ids are ignored.
 */
export async function deleteSessionFiles(dirs: SessionDataDirs, sessionIds: string[]): Promise<number> {
  const ids = new Set(sessionIds.filter((id) => SESSION_ID.test(id)));
  if (!ids.size) return 0;
  const touched = new Set<string>();

  let slugDirs: string[] = [];
  try {
    slugDirs = (await fsp.readdir(dirs.sessionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dirs.sessionsDir, entry.name));
  } catch {
    // No sessions yet.
  }

  for (const slugDir of slugDirs) {
    let names: string[] = [];
    try {
      names = await fsp.readdir(slugDir);
    } catch {
      continue;
    }
    for (const name of names) {
      // Files are `<createdAt>-<id>.jsonl` and ids contain dashes, so match
      // by suffix against the requested ids rather than parsing the name.
      const id = [...ids].find((candidate) => name.endsWith(`-${candidate}.jsonl`));
      if (!id) continue;
      await fsp.rm(path.join(slugDir, name), { force: true });
      touched.add(id);
    }
    // Drop the per-project folder once its last session is gone.
    if (!(await fsp.readdir(slugDir).catch(() => ['keep'])).length) await fsp.rmdir(slugDir).catch(() => {});
  }

  for (const id of ids) {
    const dir = path.join(dirs.checkpointsDir, id);
    // path.join with a validated id cannot escape checkpointsDir.
    const existed = await fsp.stat(dir).then(() => true, () => false);
    if (!existed) continue;
    await fsp.rm(dir, { recursive: true, force: true });
    touched.add(id);
  }
  return touched.size;
}
