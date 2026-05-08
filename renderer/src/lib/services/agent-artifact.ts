import type { AgentArtifact } from '$lib/types/chat';

export type ArtifactContext = {
  files: Record<string, string>;
  workProduct?: AgentArtifact['workProduct'];
};

export function buildArtifactFromContext(ctx: ArtifactContext): AgentArtifact | null {
  const visible = Object.keys(ctx.files).filter((path) => !path.startsWith('__'));
  if (!visible.length) return null;
  return {
    title: ctx.workProduct?.title || (visible.length === 1 ? visible[0] : 'Generated documents'),
    files: { ...ctx.files },
    previewHtml: ctx.files['__preview__.html'] ?? null,
    workProduct: ctx.workProduct || null
  };
}

export function addGeneratedArtifactFile(params: {
  executionMode: 'workspace' | 'sandbox';
  files: Record<string, string>;
  file: { path: string; dataUrl: string; mime: string; previewHtml?: string };
  viewerPathFor: (path: string) => string;
  ok: (output: unknown, extra?: Record<string, unknown>) => { success: true } & Record<string, unknown>;
  fail: (error: string, note?: string) => { success: false; error: string; note?: string };
}) {
  if (params.executionMode === 'workspace') {
    return params.fail('Office/PDF artifact generation is currently available in chat sandbox mode only.');
  }
  params.files[params.file.path] = params.file.dataUrl;
  if (params.file.previewHtml) {
    params.files[params.viewerPathFor(params.file.path)] = params.file.previewHtml;
    params.files['__preview__.html'] = params.file.previewHtml;
  }
  return params.ok(
    { path: params.file.path, mime: params.file.mime, size: params.file.dataUrl.length, preview: !!params.file.previewHtml },
    { createdFiles: [params.file.path] }
  );
}

export function synthesizeArtifactCompletion(files: Record<string, string>): string {
  const visible = Object.keys(files)
    .filter((path) => !path.startsWith('__'))
    .sort((a, b) => a.localeCompare(b));
  if (!visible.length) return '';

  const previewable = visible.some((path) => path.endsWith('.html')) || !!files['__preview__.html'];
  const listed = visible.slice(0, 4).join(', ');
  const extra = visible.length > 4 ? ` and ${visible.length - 4} more` : '';

  if (previewable) {
    return `Done. I created ${listed}${extra} and prepared a preview.`;
  }
  return `Done. I created ${listed}${extra}.`;
}
