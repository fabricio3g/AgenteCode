// ── Turn checkpoints ───────────────────────────────────────────────────
// Before a mutating tool touches a file, its pre-turn content is copied
// into `<checkpointRoot>/<turn>/before/<relpath>`. At turn end the store
// diffs before vs. now (additions/deletions per file) for the UI, and can
// restore a whole turn — the lightweight rollback substrate.

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgenteCheckpointSummary } from '../../../shared/agente-protocol.ts';

export interface FileDiffStat {
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

/** Line-count diff — good enough for stats; the UI renders real diffs from details. */
function diffLineStats(before: string, after: string): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  const a = before.split('\n');
  const b = after.split('\n');
  // Cap the DP for very large files: fall back to a crude delta.
  if (a.length * b.length > 4_000_000) {
    return { additions: Math.max(0, b.length - a.length), deletions: Math.max(0, a.length - b.length) };
  }
  // Classic LCS table.
  const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: b.length - common, deletions: a.length - common };
}

export class CheckpointStore {
  constructor(private readonly checkpointRoot: string) {}

  private turnDir(turnIndex: number): string {
    return path.join(this.checkpointRoot, String(turnIndex));
  }

  private beforeDir(turnIndex: number): string {
    return path.join(this.turnDir(turnIndex), 'before');
  }

  /** Copy the file's current (pre-change) state for this turn. Idempotent per turn+file. */
  async capture(absPath: string, projectRoot: string, turnIndex: number): Promise<void> {
    const rel = path.relative(projectRoot, absPath);
    const dest = path.join(this.beforeDir(turnIndex), rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.copyFile(absPath, dest, fsp.constants.COPYFILE_EXCL);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File does not exist yet — record the creation so rollback deletes it.
        await fsp.writeFile(dest + '.absent', '', { flag: 'wx' }).catch(() => {});
      }
      // EEXIST: already captured this turn.
    }
  }

  /** Diff every captured file against its current state. */
  async finalizeTurn(projectRoot: string, turnIndex: number): Promise<FileDiffStat[]> {
    const beforeDir = this.beforeDir(turnIndex);
    const stats: FileDiffStat[] = [];
    const walk = async (dir: string, relPrefix: string) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, rel);
        } else if (entry.name.endsWith('.absent')) {
          const fileRel = rel.slice(0, -'.absent'.length);
          const current = await fsp.readFile(path.join(projectRoot, fileRel), 'utf8').catch(() => null);
          stats.push({
            path: fileRel,
            kind: 'created',
            additions: current ? current.split('\n').length : 0,
            deletions: 0
          });
        } else {
          const before = await fsp.readFile(abs, 'utf8').catch(() => '');
          const current = await fsp.readFile(path.join(projectRoot, rel), 'utf8').catch(() => null);
          if (current === null) {
            stats.push({ path: rel, kind: 'deleted', additions: 0, deletions: before.split('\n').length });
          } else if (before !== current) {
            const { additions, deletions } = diffLineStats(before, current);
            stats.push({ path: rel, kind: 'modified', additions, deletions });
          }
        }
      }
    };
    await walk(beforeDir, '');
    if (stats.length) {
      await fsp.mkdir(this.turnDir(turnIndex), { recursive: true });
      await fsp.writeFile(path.join(this.turnDir(turnIndex), 'stats.json'), JSON.stringify(stats), 'utf8');
    }
    return stats;
  }

  async listTurns(): Promise<AgenteCheckpointSummary[]> {
    let turnDirs;
    try {
      turnDirs = await fsp.readdir(this.checkpointRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const summaries: AgenteCheckpointSummary[] = [];
    for (const entry of turnDirs) {
      if (!entry.isDirectory()) continue;
      const turnIndex = Number(entry.name);
      if (!Number.isInteger(turnIndex)) continue;
      let stats: FileDiffStat[] = [];
      try {
        stats = JSON.parse(await fsp.readFile(path.join(this.turnDir(turnIndex), 'stats.json'), 'utf8'));
      } catch {
        // Turn not finalized (crash mid-turn) — still listable.
      }
      summaries.push({
        turnIndex,
        createdAt: (await fsp.stat(this.turnDir(turnIndex)).then((s) => s.mtimeMs)).valueOf(),
        fileCount: stats.length,
        additions: stats.reduce((sum, s) => sum + s.additions, 0),
        deletions: stats.reduce((sum, s) => sum + s.deletions, 0)
      });
    }
    return summaries.sort((a, b) => a.turnIndex - b.turnIndex);
  }

  /** Restore every file captured in `turnIndex` to its pre-turn state. */
  async restore(projectRoot: string, turnIndex: number): Promise<number> {
    const beforeDir = this.beforeDir(turnIndex);
    let restored = 0;
    const walk = async (dir: string, relPrefix: string) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, rel);
        } else if (entry.name.endsWith('.absent')) {
          await fsp.rm(path.join(projectRoot, rel.slice(0, -'.absent'.length)), { force: true });
          restored += 1;
        } else {
          await fsp.mkdir(path.dirname(path.join(projectRoot, rel)), { recursive: true });
          await fsp.copyFile(abs, path.join(projectRoot, rel));
          restored += 1;
        }
      }
    };
    await walk(beforeDir, '');
    return restored;
  }
}
