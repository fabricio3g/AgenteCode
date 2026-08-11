import type {
  AgentArtifact,
  ArtifactIssue,
  ArtifactKind,
  ArtifactManifest,
  ArtifactPresentation,
  ArtifactStatus
} from '$lib/types/chat';
import { isDataUrlFile, isHiddenArtifactFile, viewerPathFor } from '$lib/utils/artifact-files';

const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'csv', 'docx', 'xlsx', 'pptx', 'pdf']);
const EDITABLE_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'svg', 'txt', 'md', 'markdown', 'csv', 'xml']);

export type ArtifactPreviewSource = {
  html: string;
  basePath: string;
  source: 'manifest' | 'viewer' | 'html' | 'legacy';
} | null;

export interface ResolvedArtifact {
  artifact: AgentArtifact;
  manifest: ArtifactManifest;
  visibleFiles: Array<[path: string, content: string]>;
  preview: ArtifactPreviewSource;
  capabilities: {
    preview: boolean;
    source: boolean;
    edit: boolean;
    download: boolean;
  };
}

function extension(path: string): string {
  return path.split('.').pop()?.toLowerCase() || '';
}

function uniqueIssues(issues: ArtifactIssue[]): ArtifactIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.severity}:${issue.path || ''}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/*
 * Only reached when an artifact carries no manifest — legacy data, or an artifact
 * assembled outside the tool dispatcher. Every agent-produced artifact should have
 * one; see `ArtifactContext.artifactManifest`.
 *
 * Office and PDF extensions are tested *before* the HTML/preview check. The other
 * order looks harmless but was the single most damaging bug in the artifact path:
 * every generated document also writes a `__preview__.html` for its viewer, so a
 * .docx/.xlsx/.pptx/.pdf artifact matched `web` first and got a bare sandboxed
 * iframe. DocxViewer, XlsxViewer and PdfViewer were unreachable from an artifact.
 */
function inferredKind(artifact: AgentArtifact, visiblePaths: string[]): ArtifactKind {
  if (artifact.inline?.kind) return artifact.inline.kind;
  if (artifact.workProduct) return 'work_product';
  const extensions = visiblePaths.map(extension);
  if (extensions.includes('docx')) return 'document';
  if (extensions.includes('xlsx')) return 'spreadsheet';
  if (extensions.includes('pptx')) return 'presentation';
  if (extensions.includes('pdf')) return 'pdf';
  if (artifact.previewHtml || visiblePaths.some((path) => /\.html?$/i.test(path))) return 'web';
  if (extensions.some((ext) => ext === 'md' || ext === 'markdown')) return 'report';
  return 'files';
}

function inferredPresentation(artifact: AgentArtifact, kind: ArtifactKind, visiblePaths: string[]): ArtifactPresentation {
  // Work products come first. When `inline` was checked first, a turn that produced
  // a work product *and* a chart resolved to `inline`, and the work product's
  // document surface never rendered — its files were reachable only via the studio.
  if (artifact.workProduct || ['report', 'document', 'spreadsheet', 'presentation', 'pdf', 'research_package'].includes(kind)) {
    return 'document';
  }
  if (artifact.inline) return 'inline';
  if (artifact.previewHtml || visiblePaths.some((path) => /\.html?$/i.test(path))) return 'web';
  return 'files';
}

function inferredEntryPath(artifact: AgentArtifact, visiblePaths: string[]): string | undefined {
  const declared = artifact.manifest?.entryPath;
  if (declared && (declared in artifact.files || artifact.files[viewerPathFor(declared)])) return declared;

  const workProductEntry = artifact.workProduct?.files.find((file) => file.previewPath && artifact.files[file.previewPath])?.path
    || artifact.workProduct?.files.find((file) => artifact.files[file.path])?.path;
  if (workProductEntry) return workProductEntry;

  return visiblePaths.find((path) => artifact.files[viewerPathFor(path)])
    || visiblePaths.find((path) => /\.html?$/i.test(path))
    || visiblePaths[0];
}

function resolveStatus(artifact: AgentArtifact, issues: ArtifactIssue[], hasContent: boolean): ArtifactStatus {
  if (!hasContent || issues.some((issue) => issue.severity === 'error')) return 'invalid';
  if (artifact.manifest?.status === 'invalid') return 'invalid';
  if (artifact.workProduct?.status === 'failed') return 'invalid';
  if (artifact.manifest?.status === 'partial' || artifact.workProduct?.status === 'partial' || issues.length > 0 || artifact.workProduct?.warnings?.length) return 'partial';
  return 'ready';
}

export function normalizeArtifact(artifact: AgentArtifact): AgentArtifact {
  const files = artifact.files && typeof artifact.files === 'object' ? artifact.files : {};
  const visiblePaths = Object.keys(files).filter((path) => !isHiddenArtifactFile(path)).sort((a, b) => a.localeCompare(b));
  const issues = [...(artifact.manifest?.issues || [])];
  const hasContent = visiblePaths.length > 0 || !!artifact.inline || !!artifact.previewHtml;
  if (!hasContent) {
    issues.push({ code: 'artifact.empty', severity: 'error', message: 'This artifact does not contain any renderable files or preview data.' });
  }
  for (const warning of artifact.workProduct?.warnings || []) {
    issues.push({ code: 'artifact.work_product_warning', severity: 'warning', message: warning });
  }

  const kind = artifact.manifest?.kind || inferredKind(artifact, visiblePaths);
  const presentation = artifact.manifest?.presentation || inferredPresentation(artifact, kind, visiblePaths);
  const entryPath = inferredEntryPath(artifact, visiblePaths);
  const normalizedIssues = uniqueIssues(issues);
  const status = resolveStatus(artifact, normalizedIssues, hasContent);

  return {
    ...artifact,
    files,
    manifest: {
      schemaVersion: 1,
      kind,
      presentation,
      ...(entryPath ? { entryPath } : {}),
      status,
      ...(normalizedIssues.length ? { issues: normalizedIssues } : {})
    }
  };
}

export function resolveArtifactPreview(artifact: AgentArtifact): ArtifactPreviewSource {
  const normalized = normalizeArtifact(artifact);
  const files = normalized.files;
  const entryPath = normalized.manifest?.entryPath;

  if (entryPath) {
    const viewerPath = viewerPathFor(entryPath);
    if (files[viewerPath]) return { html: files[viewerPath], basePath: viewerPath, source: 'viewer' };
    if (/\.html?$/i.test(entryPath) && files[entryPath]) {
      return { html: files[entryPath], basePath: entryPath, source: 'manifest' };
    }
  }

  const viewerEntry = Object.keys(files).find((path) => path.startsWith('__viewer__/') && /\.html$/i.test(path) && files[path]);
  if (viewerEntry) return { html: files[viewerEntry], basePath: viewerEntry, source: 'viewer' };

  const htmlEntry = Object.keys(files).filter((path) => !isHiddenArtifactFile(path)).find((path) => /\.html?$/i.test(path));
  if (htmlEntry && files[htmlEntry]) return { html: files[htmlEntry], basePath: htmlEntry, source: 'html' };

  if (artifact.previewHtml) return { html: artifact.previewHtml, basePath: 'index.html', source: 'legacy' };
  return null;
}

export function resolveArtifactPresentation(artifact: AgentArtifact): ResolvedArtifact {
  const normalized = normalizeArtifact(artifact);
  const visibleFiles = Object.entries(normalized.files).filter(([path]) => !isHiddenArtifactFile(path));
  const preview = resolveArtifactPreview(normalized);
  const hasEditableFile = visibleFiles.some(([path, content]) => !isDataUrlFile(content) && EDITABLE_EXTENSIONS.has(extension(path)));
  return {
    artifact: normalized,
    manifest: normalized.manifest as ArtifactManifest,
    visibleFiles,
    preview,
    capabilities: {
      preview: !!normalized.inline || !!preview || visibleFiles.some(([path]) => DOCUMENT_EXTENSIONS.has(extension(path))),
      source: visibleFiles.length > 0,
      edit: hasEditableFile,
      download: visibleFiles.length > 0
    }
  };
}

export function withArtifactIssue(artifact: AgentArtifact, issue: ArtifactIssue): AgentArtifact {
  const normalized = normalizeArtifact(artifact);
  return normalizeArtifact({
    ...normalized,
    manifest: {
      ...(normalized.manifest as ArtifactManifest),
      issues: uniqueIssues([...(normalized.manifest?.issues || []), issue])
    }
  });
}
