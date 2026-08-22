// ── Download planning (pure logic) ─────────────────────────────────────
// The decision layer of the download engine, kept free of Node/Electron
// imports so it is directly testable: shard expansion, resume planning,
// progress aggregation, and the disk-space guard.

export const SHARD_PATTERN = /-(\d+)-of-(\d+)\.gguf$/i;

/**
 * Expand a requested file into its shard list.
 * `model-00001-of-00003.gguf` → all three shards; anything else → [file].
 */
export function expandShards(file: string): string[] {
  const match = String(file || '').match(SHARD_PATTERN);
  if (!match) return [file];
  const total = parseInt(match[2], 10);
  if (!Number.isFinite(total) || total < 1 || total > 10_000) return [file];
  const width = match[1].length;
  const prefix = file.slice(0, file.length - match[0].length);
  return Array.from({ length: total }, (_, i) => `${prefix}-${String(i + 1).padStart(width, '0')}-of-${match[2]}.gguf`);
}

export interface ResumePlan {
  /** Bytes already on disk that the request will skip past. */
  offset: number;
  /** Extra headers for the resume request (Range + If-Range). */
  headers: Record<string, string>;
  /** append keeps the .part bytes; truncate restarts the file. */
  writeMode: 'append' | 'truncate';
}

/**
 * Decide how to continue from a partial download.
 *
 * A .part file only proves the bytes match when we also hold the etag from
 * the response that produced them — otherwise the remote file may have
 * changed under us and the resumed file would be silently corrupt.
 */
export function planResume(options: { partSize: number; storedEtag?: string | null; currentEtag?: string | null }): ResumePlan {
  const partSize = Math.max(0, Math.floor(Number(options.partSize) || 0));
  if (partSize === 0 || !options.storedEtag) {
    return { offset: 0, headers: {}, writeMode: 'truncate' };
  }
  // If-Range makes the server answer with 206 while the etag still matches
  // and with a full 200 (which we then treat as a restart) when it changed.
  return {
    offset: partSize,
    headers: { Range: `bytes=${partSize}-`, 'If-Range': options.storedEtag },
    writeMode: 'append'
  };
}

/** Handle a resume response: 206 continues, anything else restarts cleanly. */
export function applyResumeResponse(plan: ResumePlan, status: number): ResumePlan {
  if (plan.offset > 0 && status !== 206) {
    return { offset: 0, headers: {}, writeMode: 'truncate' };
  }
  return plan;
}

export interface ShardProgress {
  sizeBytes: number;
  doneBytes: number;
}

/** Aggregate per-shard progress into job-level totals. */
export function aggregateProgress(shards: ShardProgress[]): { totalBytes: number; downloadedBytes: number; progress: number } {
  let totalBytes = 0;
  let downloadedBytes = 0;
  for (const shard of shards) {
    totalBytes += Math.max(0, Number(shard.sizeBytes) || 0);
    downloadedBytes += Math.max(0, Number(shard.doneBytes) || 0);
  }
  const progress = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
  return { totalBytes, downloadedBytes, progress };
}

/**
 * The disk-space guard, phrased as data so the caller owns the wording.
 * Returns an error message when the remaining bytes cannot fit.
 */
export function checkDiskSpace(options: { expectedRemainingBytes: number; freeBytes: number }): string | null {
  const expected = Number(options.expectedRemainingBytes) || 0;
  const free = Number(options.freeBytes);
  if (!Number.isFinite(free)) return null; // unknown volume — do not block
  if (expected > free) {
    const needGb = (expected / 1024 ** 3).toFixed(1);
    const freeGb = (free / 1024 ** 3).toFixed(1);
    return `Not enough disk space: ${needGb} GB needed, ${freeGb} GB free.`;
  }
  return null;
}
