import type { GeneratedArtifactFile } from '$lib/services/generated-documents';
import type { ToolContext, ToolResult } from '$lib/services/agent-types';

async function createArtifactWithValidation(params: {
  ctx: ToolContext;
  args: Record<string, unknown>;
  formats: Array<'docx' | 'xlsx' | 'pptx' | 'pdf'>;
  thinContentMessage: string;
  thinContentNote: string;
  createFile: (args: Record<string, unknown>) => Promise<GeneratedArtifactFile>;
  addGeneratedArtifactFile: (ctx: ToolContext, file: GeneratedArtifactFile) => ToolResult;
  validateGeneratedDocumentArgs: (args: Record<string, unknown>, formats: string[]) => { ok: boolean; error?: string };
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const validation = params.validateGeneratedDocumentArgs(params.args, params.formats);
  if (!validation.ok) return params.fail(validation.error || params.thinContentMessage, params.thinContentNote);
  const file = await params.createFile(params.args);
  return params.addGeneratedArtifactFile(params.ctx, file);
}

export async function handleCreateDocument(params: {
  isElectron: () => boolean;
  ctx: ToolContext;
  args: Record<string, unknown>;
  createDocxArtifactFile: (args: Record<string, unknown>) => Promise<GeneratedArtifactFile>;
  addGeneratedArtifactFile: (ctx: ToolContext, file: GeneratedArtifactFile) => ToolResult;
  validateGeneratedDocumentArgs: (args: Record<string, unknown>, formats: string[]) => { ok: boolean; error?: string };
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  if (!params.isElectron()) return params.fail('DOCX generation requires the desktop app.');
  try {
    return await createArtifactWithValidation({
      ctx: params.ctx,
      args: params.args,
      formats: ['docx'],
      thinContentMessage: 'Document content is too thin.',
      thinContentNote: 'Rebuild the document from gathered evidence with meaningful body content, sources, and limitations.',
      createFile: params.createDocxArtifactFile,
      addGeneratedArtifactFile: params.addGeneratedArtifactFile,
      validateGeneratedDocumentArgs: params.validateGeneratedDocumentArgs,
      fail: params.fail
    });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}

export async function handleCreateSpreadsheet(params: {
  isElectron: () => boolean;
  ctx: ToolContext;
  args: Record<string, unknown>;
  createXlsxArtifactFile: (args: Record<string, unknown>) => Promise<GeneratedArtifactFile>;
  addGeneratedArtifactFile: (ctx: ToolContext, file: GeneratedArtifactFile) => ToolResult;
  validateGeneratedDocumentArgs: (args: Record<string, unknown>, formats: string[]) => { ok: boolean; error?: string };
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  if (!params.isElectron()) return params.fail('XLSX generation requires the desktop app.');
  try {
    return await createArtifactWithValidation({
      ctx: params.ctx,
      args: params.args,
      formats: ['xlsx'],
      thinContentMessage: 'Spreadsheet content is too thin.',
      thinContentNote: 'Rebuild the spreadsheet with actual rows from gathered evidence or source rows with limitations.',
      createFile: params.createXlsxArtifactFile,
      addGeneratedArtifactFile: params.addGeneratedArtifactFile,
      validateGeneratedDocumentArgs: params.validateGeneratedDocumentArgs,
      fail: params.fail
    });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}

export async function handleCreatePresentation(params: {
  isElectron: () => boolean;
  ctx: ToolContext;
  args: Record<string, unknown>;
  createPptxArtifactFile: (args: Record<string, unknown>) => Promise<GeneratedArtifactFile>;
  addGeneratedArtifactFile: (ctx: ToolContext, file: GeneratedArtifactFile) => ToolResult;
  validateGeneratedDocumentArgs: (args: Record<string, unknown>, formats: string[]) => { ok: boolean; error?: string };
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  if (!params.isElectron()) return params.fail('PPTX generation requires the desktop app.');
  try {
    return await createArtifactWithValidation({
      ctx: params.ctx,
      args: params.args,
      formats: ['pptx'],
      thinContentMessage: 'Presentation content is too thin.',
      thinContentNote: 'Rebuild the deck with at least one content slide populated from gathered evidence.',
      createFile: params.createPptxArtifactFile,
      addGeneratedArtifactFile: params.addGeneratedArtifactFile,
      validateGeneratedDocumentArgs: params.validateGeneratedDocumentArgs,
      fail: params.fail
    });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}

export async function handleCreatePdf(params: {
  isElectron: () => boolean;
  ctx: ToolContext;
  args: Record<string, unknown>;
  createPdfArtifactFile: (args: Record<string, unknown>) => Promise<GeneratedArtifactFile>;
  addGeneratedArtifactFile: (ctx: ToolContext, file: GeneratedArtifactFile) => ToolResult;
  validateGeneratedDocumentArgs: (args: Record<string, unknown>, formats: string[]) => { ok: boolean; error?: string };
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  if (!params.isElectron()) return params.fail('PDF generation requires the desktop app.');
  try {
    return await createArtifactWithValidation({
      ctx: params.ctx,
      args: params.args,
      formats: ['pdf'],
      thinContentMessage: 'Document content is too thin.',
      thinContentNote: 'Rebuild the PDF from gathered evidence with meaningful body content, sources, and limitations.',
      createFile: params.createPdfArtifactFile,
      addGeneratedArtifactFile: params.addGeneratedArtifactFile,
      validateGeneratedDocumentArgs: params.validateGeneratedDocumentArgs,
      fail: params.fail
    });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}
