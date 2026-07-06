import { invoke, isTauri } from '$lib/services/tauri';
import type { CodeAgentDiffStat } from '$lib/types/chat';

export type WorkspaceSnapshotFile = {
  path: string;
  content: string;
  size?: number;
  lineCount?: number;
};

export type WorkspaceSnapshot = {
  files: WorkspaceSnapshotFile[];
};

export async function snapshotWorkspace(rootPath?: string): Promise<WorkspaceSnapshot | null> {
  if (!rootPath || !isTauri()) return null;
  try {
    const result = await invoke<WorkspaceSnapshot>('snapshot_workspace_files', { workspaceRoot: rootPath });
    return result && Array.isArray(result.files) ? result : { files: [] };
  } catch {
    return null;
  }
}

function countLines(content: string) {
  if (!content) return 0;
  return content.split('\n').length;
}

function diffLineCounts(before: string, after: string) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  let additions = 0;
  let deletions = 0;
  for (let i = 0; i < max; i += 1) {
    const left = beforeLines[i];
    const right = afterLines[i];
    if (left === right) continue;
    if (left !== undefined) deletions += 1;
    if (right !== undefined) additions += 1;
  }
  return { additions, deletions };
}

export function computeSnapshotDiff(before: WorkspaceSnapshot | null, after: WorkspaceSnapshot | null): CodeAgentDiffStat[] {
  if (!before || !after) return [];
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const afterByPath = new Map(after.files.map((file) => [file.path, file]));
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  const stats: CodeAgentDiffStat[] = [];

  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const oldFile = beforeByPath.get(path);
    const newFile = afterByPath.get(path);
    if (!oldFile && newFile) {
      stats.push({ path, kind: 'created', additions: countLines(newFile.content), deletions: 0, after: newFile.content });
      continue;
    }
    if (oldFile && !newFile) {
      stats.push({ path, kind: 'deleted', additions: 0, deletions: countLines(oldFile.content), before: oldFile.content });
      continue;
    }
    if (!oldFile || !newFile || oldFile.content === newFile.content) continue;
    const counts = diffLineCounts(oldFile.content, newFile.content);
    stats.push({ path, kind: 'modified', ...counts, before: oldFile.content, after: newFile.content });
  }

  return stats;
}
