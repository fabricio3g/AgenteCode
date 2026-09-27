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

  /**
   * Visit every file captured for a turn: its path relative to the project,
   * the snapshot's absolute path, and whether it marks a file that did not
   * exist before the turn (`.absent`).
   */
  private async eachCaptured(
    turnIndex: number,
    visit: (rel: string, snapshot: string, absent: boolean) => Promise<void>
  ): Promise<void> {
    const walk = async (dir: string, relPrefix: string): Promise<void> => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs, rel);
        else if (entry.name.endsWith('.absent')) await visit(rel.slice(0, -'.absent'.length), abs, true);
        else await visit(rel, abs, false);
      }
    };
    await walk(this.beforeDir(turnIndex), '');
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
    const stats: FileDiffStat[] = [];
    await this.eachCaptured(turnIndex, async (rel, snapshot, absent) => {
      const current = await fsp.readFile(path.join(projectRoot, rel), 'utf8').catch(() => null);
      if (absent) {
        stats.push({ path: rel, kind: 'created', additions: current ? current.split('\n').length : 0, deletions: 0 });
        return;
      }
      const before = await fsp.readFile(snapshot, 'utf8').catch(() => '');
      if (current === null) {
        stats.push({ path: rel, kind: 'deleted', additions: 0, deletions: before.split('\n').length });
      } else if (before !== current) {
        const { additions, deletions } = diffLineStats(before, current);
        stats.push({ path: rel, kind: 'modified', additions, deletions });
      }
    });
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
        deletions: stats.reduce((sum, s) => sum + s.deletions, 0),
        files: stats.map((stat) => stat.path)
      });
    }
    return summaries.sort((a, b) => a.turnIndex - b.turnIndex);
  }

  /**
   * Put the project back to how it was before `turnIndex`: undo that turn and
   * every later one, newest first (so a file touched in several turns ends at
   * its oldest snapshot), then forget those checkpoints — they describe
   * changes that no longer exist. Returns the paths that were restored.
   */
  async restoreTo(projectRoot: string, turnIndex: number): Promise<string[]> {
    const turns = (await this.listTurns())
      .map((turn) => turn.turnIndex)
      .filter((index) => index >= turnIndex)
      .sort((a, b) => b - a);
    const paths = new Set<string>();
    for (const index of turns) {
      for (const rel of await this.capturedPaths(index)) paths.add(rel);
      await this.restore(projectRoot, index);
    }
    for (const index of turns) {
      await fsp.rm(this.turnDir(index), { recursive: true, force: true });
    }
    return [...paths].sort();
  }

  /** Relative paths captured in a turn (created files included). */
  private async capturedPaths(turnIndex: number): Promise<string[]> {
    const out: string[] = [];
    await this.eachCaptured(turnIndex, async (rel) => {
      out.push(rel);
    });
    return out;
  }

  /** Restore every file captured in `turnIndex` to its pre-turn state. */
  async restore(projectRoot: string, turnIndex: number): Promise<number> {
    let restored = 0;
    await this.eachCaptured(turnIndex, async (rel, snapshot, absent) => {
      const target = path.join(projectRoot, rel);
      if (absent) {
        await fsp.rm(target, { force: true });
      } else {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(snapshot, target);
      }
      restored += 1;
    });
    return restored;
  }
}
