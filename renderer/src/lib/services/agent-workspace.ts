import type { WorkspaceFile } from '$lib/types/chat';

export type WorkspaceContextLike = {
  executionMode: 'workspace' | 'sandbox';
  workspaceRoot?: string;
  workspaceFiles?: WorkspaceFile[];
  files: Record<string, string>;
};

export function isWorkspace(ctx: WorkspaceContextLike): boolean {
  return ctx.executionMode === 'workspace' && !!ctx.workspaceRoot;
}

export function normPath(pathValue: unknown): string {
  return String(pathValue || '').replace(/^\/+/, '').replace(/\\/g, '/').trim();
}

export function getWsFiles(ctx: WorkspaceContextLike): WorkspaceFile[] {
  if (!ctx.workspaceFiles) ctx.workspaceFiles = [];
  return ctx.workspaceFiles;
}

export function upsertWsFile(ctx: WorkspaceContextLike, path: string, size = 0): void {
  const files = getWsFiles(ctx);
  const idx = files.findIndex((file) => file.path === path);
  const entry: WorkspaceFile = {
    path,
    name: path.split('/').pop() || path,
    size,
    type: path.split('.').pop()?.toLowerCase() || 'text',
    status: 'ready'
  };
  if (idx >= 0) files[idx] = entry;
  else files.unshift(entry);
}

export async function readWsText(
  path: string,
  ctx: WorkspaceContextLike,
  readWorkspaceFile: (workspaceRoot: string, path: string) => Promise<string>
): Promise<string> {
  if (!ctx.workspaceRoot) throw new Error('No workspace root');
  if (path in ctx.files) return ctx.files[path];
  const content = await readWorkspaceFile(ctx.workspaceRoot, path);
  ctx.files[path] = content;
  upsertWsFile(ctx, path, content.length);
  return content;
}

export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  return new RegExp(`^${escaped}$`);
}
