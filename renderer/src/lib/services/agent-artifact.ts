import type { AgentArtifact, ArtifactManifest, InlineArtifactPayload } from '$lib/types/chat';
import type { ToolResult } from '$lib/services/agent-types';
import { normalizeArtifact } from '$lib/services/artifact-model';
import { specPathFor, viewerPathFor } from '$lib/utils/artifact-files';

export const INLINE_ARTIFACT_FILE = '__artifact__.json';

export type ArtifactContext = {
  files: Record<string, string>;
  workProduct?: AgentArtifact['workProduct'];
  /**
   * Required, not optional. This used to be `artifactManifest?`, and the agent's
   * `buildArtifact` simply forgot to pass it — silently, because the field was
   * optional. Every agent-produced artifact therefore carried `manifest: null` and
   * fell back to inference, which mis-resolved every generated document, spreadsheet
   * and PDF to `kind: 'web'` and routed them to a raw iframe instead of their real
   * viewer. Making it required turns that whole class of omission into a type error.
   */
  artifactManifest: ArtifactManifest | null;
};

export const INLINE_ARTIFACT_KINDS = ['chart', 'map', 'diagram', 'dashboard', 'info_card', 'html_card'];

function parseInlinePayload(raw: string | undefined): InlineArtifactPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as InlineArtifactPayload;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.kind !== 'string') return null;
    if (!INLINE_ARTIFACT_KINDS.includes(parsed.kind)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Legacy whole-context read. Kept for artifacts rehydrated from storage, which were
 * written when every inline payload shared the single `__artifact__.json` slot.
 * New artifacts are built per tool call by `buildScopedArtifact`.
 */
function parseInlineArtifact(files: Record<string, string>): InlineArtifactPayload | null {
  return parseInlinePayload(files[INLINE_ARTIFACT_FILE]);
}

export function buildArtifactFromContext(ctx: ArtifactContext): AgentArtifact | null {
  const visible = Object.keys(ctx.files).filter((path) => !path.startsWith('__'));
  if (!visible.length) return null;
  return normalizeArtifact({
    title: ctx.workProduct?.title || (visible.length === 1 ? visible[0] : 'Generated documents'),
    files: { ...ctx.files },
    previewHtml: ctx.files['__preview__.html'] ?? null,
    inline: parseInlineArtifact(ctx.files),
    workProduct: ctx.workProduct || null,
    manifest: ctx.artifactManifest
  });
}

/**
 * Build one artifact describing exactly what a single tool call produced.
 *
 * `buildArtifactFromContext` reads the *whole* accumulated file map, so a turn that
 * made a chart and then a diagram produced two artifacts that were both "everything
 * so far" — and since they shared one inline slot and one message field, only the
 * last survived. Scoping to `result.createdFiles` lets every visual in a turn stand
 * on its own and render side by side.
 *
 * Note it carries no `previewHtml`. That field was the shared `__preview__.html`
 * slot, which any later inline artifact overwrote or deleted. Scoped artifacts
 * carry their own `__viewer__/…` sibling instead, which `resolveArtifactPreview`
 * finds first anyway.
 */
/** A generated file's own title (the deck's, the report's), not its file name. */
function specTitleOf(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const spec = JSON.parse(raw) as { deck?: { title?: string }; report?: { title?: string }; title?: string };
    return String(spec.deck?.title || spec.report?.title || spec.title || '').trim();
  } catch {
    return '';
  }
}

export function buildScopedArtifact(
  ctx: ArtifactContext,
  result: { createdFiles?: string[]; artifactManifest?: ArtifactManifest }
): AgentArtifact | null {
  const manifest = result.artifactManifest;
  const created = result.createdFiles || [];
  if (!manifest || !created.length) return null;

  const files: Record<string, string> = {};
  for (const path of created) {
    if (ctx.files[path] !== undefined) files[path] = ctx.files[path];
    for (const sibling of [viewerPathFor(path), specPathFor(path)]) {
      if (ctx.files[sibling] !== undefined) files[sibling] = ctx.files[sibling];
    }
  }
  if (!Object.keys(files).length) return null;

  const entryPath = manifest.entryPath && files[manifest.entryPath] !== undefined
    ? manifest.entryPath
    : created.find((path) => files[path] !== undefined);

  const visible = Object.keys(files).filter((path) => !path.startsWith('__'));
  const specTitle = entryPath ? specTitleOf(files[specPathFor(entryPath)]) : '';

  return normalizeArtifact({
    title: manifest.kind === 'work_product'
      ? (ctx.workProduct?.title || 'Work product')
      : specTitle || (visible.length === 1 ? visible[0] : 'Generated documents'),
    files,
    previewHtml: null,
    inline: entryPath ? parseInlinePayload(files[entryPath]) : null,
    // Only the work-product tool sets `ctx.workProduct`; a chart created afterwards
    // must not inherit it, or its artifact resolves as a document.
    workProduct: manifest.kind === 'work_product' ? (ctx.workProduct || null) : null,
    manifest
  });
}

/**
 * Records a generated Office/PDF file on the artifact. In workspace mode the
 * caller has already written it to disk (`savedTo`); the artifact still keeps
 * a copy so it previews in the chat either way.
 */
export function addGeneratedArtifactFile(params: {
  files: Record<string, string>;
  file: { path: string; dataUrl: string; mime: string; previewHtml?: string; spec?: unknown };
  savedTo?: string;
  viewerPathFor: (path: string) => string;
  ok: (output: unknown, extra?: Partial<ToolResult>) => ToolResult;
}): ToolResult {
  params.files[params.file.path] = params.file.dataUrl;
  if (params.file.spec) params.files[specPathFor(params.file.path)] = JSON.stringify(params.file.spec);
  if (params.file.previewHtml) {
    params.files[params.viewerPathFor(params.file.path)] = params.file.previewHtml;
    params.files['__preview__.html'] = params.file.previewHtml;
  }
  return params.ok(
    { path: params.file.path, mime: params.file.mime, size: params.file.dataUrl.length, preview: !!params.file.previewHtml, ...(params.savedTo ? { savedTo: params.savedTo } : {}) },
    { createdFiles: [params.file.path] }
  );
}

export function synthesizeArtifactCompletion(files: Record<string, string>): string {
  const visible = Object.keys(files)
    .filter((path) => !path.startsWith('__'))
    .sort((a, b) => a.localeCompare(b));
  if (!visible.length) return '';

  const previewable = visible.some((path) => path.endsWith('.html')) || !!files['__preview__.html'] || !!files[INLINE_ARTIFACT_FILE];
  const listed = visible.slice(0, 4).join(', ');
  const extra = visible.length > 4 ? ` and ${visible.length - 4} more` : '';

  if (previewable) {
    return `Done. I created ${listed}${extra} and prepared a preview.`;
  }
  return `Done. I created ${listed}${extra}.`;
}
