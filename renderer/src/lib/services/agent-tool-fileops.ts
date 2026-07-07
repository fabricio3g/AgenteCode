import type { WorkspaceFile } from '$lib/types/chat';
import type { ToolContext, ToolResult } from '$lib/services/agent-types';

export async function handleReadFile(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  isWorkspace: (ctx: ToolContext) => boolean;
  readWsText: (path: string, ctx: ToolContext) => Promise<string>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const path = params.normPath(params.args.path);
  if (!path) return params.fail('Missing path');
  if (params.isWorkspace(params.ctx)) {
    try {
      const content = await params.readWsText(path, params.ctx);
      const offset = Number(params.args.offset) || 0;
      const limit = Number(params.args.limit) || 0;
      const lines = content.split('\n');
      const totalLines = lines.length;

      if (offset > 0 || limit > 0) {
        const startLine = Math.max(0, (offset || 1) - 1);
        const endLine = limit > 0 ? Math.min(startLine + limit, totalLines) : totalLines;
        const sliced = lines.slice(startLine, endLine).join('\n');
        const note = endLine < totalLines ? `\n\n[Showing lines ${startLine + 1}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]` : '';
        return params.ok({ path, content: sliced + note, size: content.length, totalLines, startLine: startLine + 1, endLine });
      }

      // Truncate large files at ~32KB
      const MAX_BYTES = 32000;
      if (content.length > MAX_BYTES) {
        const truncated = content.slice(0, MAX_BYTES);
        return params.ok({ path, content: truncated + `\n\n[File is ${content.length} bytes, showing first ${MAX_BYTES} bytes. Use offset/limit to read more.]`, size: content.length, truncated: true });
      }

      return params.ok({ path, content, size: content.length, totalLines });
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
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  isWorkspace: (ctx: ToolContext) => boolean;
  readWsText: (path: string, ctx: ToolContext) => Promise<string>;
  writeWorkspaceFile: (workspaceRoot: string, path: string, content: string) => Promise<unknown>;
  getWsFiles: (ctx: ToolContext) => WorkspaceFile[];
  upsertWsFile: (ctx: ToolContext, path: string, size?: number) => void;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
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
    const existed = params.getWsFiles(params.ctx).some((file) => file.path === path);
    await params.writeWorkspaceFile(params.ctx.workspaceRoot, path, finalContent);
    params.ctx.files[path] = finalContent;
    params.upsertWsFile(params.ctx, path, finalContent.length);
    return params.ok({ path, size: finalContent.length, mode }, { [existed ? 'modifiedFiles' : 'createdFiles']: [path] });
  }
  const existed = path in params.ctx.files;
  if (mode === 'create' && existed) return params.fail(`File already exists: ${path}. Use mode overwrite.`);
  params.ctx.files[path] = mode === 'append' && existed ? params.ctx.files[path] + '\n' + content : content;
  return params.ok({ path, size: params.ctx.files[path].length, mode }, { [existed ? 'modifiedFiles' : 'createdFiles']: [path] });
}

export async function handleDeleteFile(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  isWorkspace: (ctx: ToolContext) => boolean;
  deleteWorkspaceFile: (workspaceRoot: string, path: string) => Promise<void>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
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

export async function handleEditFile(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  isWorkspace: (ctx: ToolContext) => boolean;
  readWsText: (path: string, ctx: ToolContext) => Promise<string>;
  writeWorkspaceFile: (workspaceRoot: string, path: string, content: string) => Promise<unknown>;
  getWsFiles: (ctx: ToolContext) => WorkspaceFile[];
  upsertWsFile: (ctx: ToolContext, path: string, size?: number) => void;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const path = params.normPath(params.args.path);
  const edits = Array.isArray(params.args.edits) ? params.args.edits : [];
  if (!path) return params.fail('Missing path');
  if (edits.length === 0) return params.fail('Missing edits array');
  if (!params.isWorkspace(params.ctx)) return params.fail('edit_file is only available in workspace mode');
  if (!params.ctx.workspaceRoot) return params.fail('No workspace root');

  try {
    let currentContent = await params.readWsText(path, params.ctx);

    // Apply each edit against the current content in reverse order (so offsets stay valid)
    let appliedCount = 0;
    let lastContent = currentContent;
    for (let i = edits.length - 1; i >= 0; i--) {
      const edit = edits[i];
      if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
        return params.fail(`Edit ${i}: oldText and newText must be strings`);
      }
      const idx = lastContent.indexOf(edit.oldText);
      if (idx === -1) {
        return params.fail(`Edit ${i}: Could not find text in ${path}. The oldText must match exactly including whitespace and newlines.`);
      }
      const beforeIdx = lastContent.indexOf(edit.oldText, idx + 1);
      if (beforeIdx !== -1) {
        return params.fail(`Edit ${i}: Found multiple occurrences of the text in ${path}. The oldText must be unique.`);
      }
      lastContent = lastContent.slice(0, idx) + edit.newText + lastContent.slice(idx + edit.oldText.length);
      appliedCount++;
    }

    // Write back to workspace
    await params.writeWorkspaceFile(params.ctx.workspaceRoot, path, lastContent);
    params.ctx.files[path] = lastContent;
    params.upsertWsFile(params.ctx, path, lastContent.length);

    // Compute simple line diff stats
    const oldLines = currentContent.split('\n');
    const newLines = lastContent.split('\n');
    let additions = 0;
    let deletions = 0;
    for (const line of newLines) {
      if (!oldLines.includes(line)) additions++;
    }
    for (const line of oldLines) {
      if (!newLines.includes(line)) deletions++;
    }

    return params.ok(
      { path, replacements: appliedCount, additions, deletions },
      {
        modifiedFiles: [path],
        diffStats: [{
          path,
          kind: 'modified',
          additions,
          deletions,
          before: currentContent,
          after: lastContent
        }]
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return params.fail(message);
  }
}

export function handleListFiles(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  isWorkspace: (ctx: ToolContext) => boolean;
  getWsFiles: (ctx: ToolContext) => WorkspaceFile[];
  globToRegex: (pattern: string) => RegExp;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
}): ToolResult {
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
  ctx: ToolContext;
  isWorkspace: (ctx: ToolContext) => boolean;
  getWsFiles: (ctx: ToolContext) => WorkspaceFile[];
  readWsText: (path: string, ctx: ToolContext) => Promise<string>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const query = String(params.args.query || '');
  if (!query) return params.fail('query required');
  const caseSensitive = params.args.caseSensitive === true;
  const maxResults = Number(params.args.maxResults) || 50;
  const pathFilter = String(params.args.path || '');
  const re = new RegExp(query, caseSensitive ? 'g' : 'gi');
  const targets = params.isWorkspace(params.ctx)
    ? params.getWsFiles(params.ctx).map((file) => file.path)
    : Object.keys(params.ctx.files).filter((path) => !path.startsWith('__'));
  const filteredTargets = pathFilter ? targets.filter((t) => t.startsWith(pathFilter)) : targets;
  const results: Array<{ file: string; line: number; content: string }> = [];
  for (const file of filteredTargets.slice(0, 200)) {
    if (results.length >= maxResults) break;
    params.ctx.signal?.throwIfAborted?.();
    try {
      const content = params.isWorkspace(params.ctx) ? await params.readWsText(file, params.ctx) : params.ctx.files[file];
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (results.length >= maxResults) return;
        re.lastIndex = 0;
        if (re.test(line)) results.push({ file, line: index + 1, content: line.trim().slice(0, 300) });
      });
    } catch {
      // skip file
    }
  }
  return params.ok({ query, results: results.slice(0, maxResults), totalMatches: results.length, truncated: results.length >= maxResults });
}

export function handlePreviewProject(params: {
  args: Record<string, unknown>;
  files: Record<string, string>;
  buildPreviewHtml: (files: Record<string, string>, entry?: string) => string | null;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
}): ToolResult {
  const entry = String(params.args.entryPoint || 'index.html');
  const html = params.buildPreviewHtml(params.files, entry);
  if (!html) {
    return params.ok({ message: 'No HTML entry point found', files: Object.keys(params.files).filter((file) => !file.startsWith('__')) });
  }
  params.files['__preview__.html'] = html;
  return params.ok({ preview: true, entryPoint: entry });
}
