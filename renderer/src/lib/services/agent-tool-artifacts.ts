import type { AgentArtifact } from '$lib/types/chat';
import type { GeneratedArtifactFile } from '$lib/services/generated-documents';
import type { ToolContext, ToolResult } from '$lib/services/agent-types';

export async function handleCreateReport(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  isWorkspace: (ctx: ToolContext) => boolean;
  buildHtmlReport: (title: string, sections: Array<{ title?: string; heading?: string; content?: string }>, options?: { theme?: 'light' | 'dark' }) => string;
  buildMarkdownReport: (title: string, sections: Array<{ title?: string; heading?: string; content?: string }>) => string;
  writeWorkspaceFile: (workspaceRoot: string, path: string, content: string) => Promise<unknown>;
  validateGeneratedDocumentArgs: (args: Record<string, unknown>, formats: string[]) => { ok: boolean; error?: string };
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const title = String(params.args.title || 'Report');
  const sections = Array.isArray(params.args.sections) ? params.args.sections as Array<{ title?: string; heading?: string; content?: string }> : [];
  const format = String(params.args.format || 'markdown');
  const theme = (params.args.theme === 'dark' ? 'dark' : 'light') as 'light' | 'dark';
  const path = params.normPath(params.args.path) || (format === 'html' ? 'report.html' : 'report.md');
  const validation = params.validateGeneratedDocumentArgs({ title, sections }, [format === 'html' ? 'html' : 'md']);
  if (!validation.ok) {
    return params.fail(
      validation.error || 'Document content is too thin.',
      'Rebuild the report using gathered evidence. Include real body content, bullets, sources, and limitations instead of only section titles.'
    );
  }
  const content = format === 'html'
    ? params.buildHtmlReport(title, sections, { theme })
    : params.buildMarkdownReport(title, sections);

  if (params.isWorkspace(params.ctx) && params.ctx.workspaceRoot) {
    await params.writeWorkspaceFile(params.ctx.workspaceRoot, path, content);
    params.ctx.files[path] = content;
  } else {
    params.ctx.files[path] = content;
    if (format === 'html') params.ctx.files['__preview__.html'] = content;
  }
  return params.ok({ title, format, path, sections: sections.length }, { createdFiles: [path] });
}

export async function handleCreateWorkProduct(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  isTauri: () => boolean;
  isWorkspace: (ctx: ToolContext) => boolean;
  uid: (prefix: string) => string;
  viewerPathFor: (path: string) => string;
  createWorkProductArtifactFiles: (args: Record<string, unknown>) => Promise<{ files: GeneratedArtifactFile[]; html?: string; warnings: string[] }>;
  validateGeneratedDocumentArgs: (args: Record<string, unknown>, formats: string[]) => { ok: boolean; error?: string };
  buildArtifact: (ctx: ToolContext) => AgentArtifact | null;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  if (!params.isTauri()) return params.fail('Professional work product generation requires the desktop app.');
  if (params.isWorkspace(params.ctx)) return params.fail('Professional work products are currently available in chat sandbox mode only.');

  try {
    const formats = Array.isArray(params.args.formats) ? params.args.formats.map((format) => String(format)) : ['md'];
    const validation = params.validateGeneratedDocumentArgs(params.args, formats);
    if (!validation.ok) {
      return params.fail(
        validation.error || 'Document content is too thin.',
        'Rebuild the work product from gathered evidence. Include meaningful body content, populated tables/slides, sources, and limitations instead of only titles.'
      );
    }
    const generated = await params.createWorkProductArtifactFiles(params.args);
    const createdFiles: string[] = [];
    for (const file of generated.files) {
      params.ctx.files[file.path] = file.dataUrl;
      createdFiles.push(file.path);
      if (file.previewHtml) params.ctx.files[params.viewerPathFor(file.path)] = file.previewHtml;
    }
    const firstPreview = generated.files.find((file) => file.previewHtml)?.previewHtml || generated.html || '';
    if (firstPreview) params.ctx.files['__preview__.html'] = firstPreview;

    const sourceIds = Array.isArray(params.args.sources)
      ? params.args.sources
          .map((source: { id?: string; url?: string; title?: string }, index: number) => String(source?.id || source?.url || source?.title || `source-${index + 1}`).trim())
          .filter(Boolean)
      : [];

    const fileKinds = new Set(generated.files.map((file) => file.path.split('.').pop()?.toLowerCase()).filter(Boolean));
    const workProductKind =
      generated.files.length > 1 ? 'bundle'
      : fileKinds.has('xlsx') ? 'spreadsheet'
      : fileKinds.has('pptx') ? 'presentation'
      : 'report';

    params.ctx.workProduct = {
      id: params.uid('work-product'),
      title: String(params.args.title || 'Work product'),
      kind: workProductKind as NonNullable<AgentArtifact['workProduct']>['kind'],
      status: generated.warnings.length ? 'partial' : 'ready',
      files: generated.files.map((file) => ({
        path: file.path,
        title: file.path.split('/').pop() || file.path,
        mime: file.mime,
        kind: file.path.split('.').pop()?.toLowerCase() as NonNullable<AgentArtifact['workProduct']>['files'][number]['kind'],
        previewPath: file.previewHtml ? params.viewerPathFor(file.path) : undefined
      })),
      sourceIds,
      evidenceMap: Object.fromEntries(generated.files.map((file) => [file.path, sourceIds])),
      warnings: generated.warnings,
      createdAt: Date.now()
    };

    params.ctx.onArtifact(params.buildArtifact(params.ctx));
    return params.ok({ title: params.ctx.workProduct.title, files: createdFiles, warnings: generated.warnings }, { createdFiles });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}
