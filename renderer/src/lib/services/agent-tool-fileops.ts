import type { WorkspaceFile } from '$lib/types/chat';

type ToolResultLike = {
  success: boolean;
  output?: unknown;
  error?: string;
  createdFiles?: string[];
  modifiedFiles?: string[];
  deletedFiles?: string[];
};

type ToolContextLike = {
  files: Record<string, string>;
  workspaceRoot?: string;
  workspaceFiles?: WorkspaceFile[];
  signal?: AbortSignal;
};

export async function handleReadFile(params: {
  args: Record<string, unknown>;
  ctx: ToolContextLike;
  normPath: (value: unknown) => string;
  isWorkspace: (ctx: ToolContextLike) => boolean;
  readWsText: (path: string, ctx: ToolContextLike) => Promise<string>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResultLike;
  fail: (error: string, note?: string) => ToolResultLike;
}): Promise<ToolResultLike> {
  const path = params.normPath(params.args.path);
  if (!path) return params.fail('Missing path');
  if (params.isWorkspace(params.ctx)) {
    try {
      const content = await params.readWsText(path, params.ctx);
      return params.ok({ path, content, size: content.length });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return params.fail(message);
    }
  }
  if (!(path in params.ctx.files)) return params.fail(`File not found: ${path}`);
  return params.ok({ path, content: params.ctx.files[path], size: params.ctx.files[path].length });
}

export async function handleWriteFile(params: {
  args: Record<string, unknown>;
  ctx: ToolContextLike;
  normPath: (value: unknown) => string;
  isWorkspace: (ctx: ToolContextLike) => boolean;
  readWsText: (path: string, ctx: ToolContextLike) => Promise<string>;
  writeWorkspaceFile: (workspaceRoot: string, path: string, content: string) => Promise<void>;
  getWsFiles: (ctx: ToolContextLike) => WorkspaceFile[];
  upsertWsFile: (ctx: ToolContextLike, path: string, size?: number) => void;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResultLike;
  fail: (error: string, note?: string) => ToolResultLike;
}): Promise<ToolResultLike> {
  const path = params.normPath(params.args.path);
  const content = String(params.args.content || '');
  const mode = String(params.args.mode || 'overwrite');
  if (!path) return params.fail('Missing path');
  if (params.isWorkspace(params.ctx)) {
    if (!params.ctx.workspaceRoot) return params.fail('No workspace root');
    let finalContent = content;
    if (mode === 'append') {
      try { finalContent = (await params.readWsText(path, params.ctx)) + '\n' + content; } catch { /* new file */ }
    }
    await params.writeWorkspaceFile(params.ctx.workspaceRoot, path, finalContent);
    params.ctx.files[path] = finalContent;
    params.upsertWsFile(params.ctx, path, finalContent.length);
    const existed = params.getWsFiles(params.ctx).some((file) => file.path === path);
    return params.ok({ path, size: finalContent.length, mode }, { [existed ? 'modifiedFiles' : 'createdFiles']: [path] });
  }
  const existed = path in params.ctx.files;
  if (mode === 'create' && existed) return params.fail(`File already exists: ${path}. Use mode overwrite.`);
  params.ctx.files[path] = mode === 'append' && existed ? params.ctx.files[path] + '\n' + content : content;
  return params.ok({ path, size: params.ctx.files[path].length, mode }, { [existed ? 'modifiedFiles' : 'createdFiles']: [path] });
}

export async function handleDeleteFile(params: {
  args: Record<string, unknown>;
  ctx: ToolContextLike;
  normPath: (value: unknown) => string;
  isWorkspace: (ctx: ToolContextLike) => boolean;
  deleteWorkspaceFile: (workspaceRoot: string, path: string) => Promise<void>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResultLike;
  fail: (error: string, note?: string) => ToolResultLike;
}): Promise<ToolResultLike> {
  const path = params.normPath(params.args.path);
  if (!path) return params.fail('Missing path');
  if (params.isWorkspace(params.ctx)) {
    if (!params.ctx.workspaceRoot) return params.fail('No workspace root');
    await params.deleteWorkspaceFile(params.ctx.workspaceRoot, path);
    delete params.ctx.files[path];
    if (params.ctx.workspaceFiles) params.ctx.workspaceFiles = params.ctx.workspaceFiles.filter((file) => file.path !== path);
    return params.ok({ path }, { deletedFiles: [path] });
  }
  if (!(path in params.ctx.files)) return params.fail(`File not found: ${path}`);
  delete params.ctx.files[path];
  return params.ok({ path }, { deletedFiles: [path] });
}

export function handleListFiles(params: {
  args: Record<string, unknown>;
  ctx: ToolContextLike;
  isWorkspace: (ctx: ToolContextLike) => boolean;
  getWsFiles: (ctx: ToolContextLike) => WorkspaceFile[];
  globToRegex: (pattern: string) => RegExp;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResultLike;
}): ToolResultLike {
  if (params.isWorkspace(params.ctx)) {
    let files = [...params.getWsFiles(params.ctx)];
    const pattern = String(params.args.pattern || '');
    if (pattern) { const re = params.globToRegex(pattern); files = files.filter((file) => re.test(file.path)); }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return params.ok({ files: files.map((file) => ({ path: file.path, size: file.size, type: file.type })), count: files.length });
  }
  let paths = Object.keys(params.ctx.files).filter((path) => !path.startsWith('__')).sort();
  const pattern = String(params.args.pattern || '');
  if (pattern) { const re = params.globToRegex(pattern); paths = paths.filter((path) => re.test(path)); }
  return params.ok({ files: paths.map((path) => ({ path, size: params.ctx.files[path].length, type: path.split('.').pop() || 'unknown' })), count: paths.length });
}

export async function handleSearchFiles(params: {
  args: Record<string, unknown>;
  ctx: ToolContextLike;
  isWorkspace: (ctx: ToolContextLike) => boolean;
  getWsFiles: (ctx: ToolContextLike) => WorkspaceFile[];
  readWsText: (path: string, ctx: ToolContextLike) => Promise<string>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResultLike;
  fail: (error: string, note?: string) => ToolResultLike;
}): Promise<ToolResultLike> {
  const query = String(params.args.query || '');
  if (!query) return params.fail('query required');
  const caseSensitive = params.args.caseSensitive === true;
  const re = new RegExp(query, caseSensitive ? 'g' : 'gi');
  const targets = params.isWorkspace(params.ctx)
    ? params.getWsFiles(params.ctx).map((file) => file.path)
    : Object.keys(params.ctx.files).filter((path) => !path.startsWith('__'));
  const results: Array<{ file: string; line: number; content: string }> = [];
  for (const file of targets.slice(0, 120)) {
    params.ctx.signal?.throwIfAborted?.();
    try {
      const content = params.isWorkspace(params.ctx) ? await params.readWsText(file, params.ctx) : params.ctx.files[file];
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        re.lastIndex = 0;
        if (re.test(line)) results.push({ file, line: index + 1, content: line.trim().slice(0, 200) });
      });
    } catch {
      // skip file
    }
  }
  return params.ok({ query, results: results.slice(0, 100), totalMatches: results.length });
}

export function handlePreviewProject(params: {
  args: Record<string, unknown>;
  files: Record<string, string>;
  buildPreviewHtml: (files: Record<string, string>, entry?: string) => string | null;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResultLike;
}): ToolResultLike {
  const entry = String(params.args.entryPoint || 'index.html');
  const html = params.buildPreviewHtml(params.files, entry);
  if (!html) {
    return params.ok({ message: 'No HTML entry point found', files: Object.keys(params.files).filter((file) => !file.startsWith('__')) });
  }
  params.files['__preview__.html'] = html;
  return params.ok({ preview: true, entryPoint: entry });
}
