import type { SlideData } from '$lib/types/bridge';
import { normalizeDeck, type DeckSpec } from '$shared/deck';
import type { GeneratedWorkProduct, WorkProductStatus } from '$lib/types/chat';
import type { ResolvedArtifact } from '$lib/services/artifact-model';
import { isDataUrlFile, specPathFor, viewerPathFor } from '$lib/utils/artifact-files';

export type DocumentSurfaceKind = 'report' | 'document' | 'slides';

export interface DocumentSurfaceItem {
  id: string;
  name: string;
  title?: string;
  type?: string;
  size?: number;
  content?: string;
  dataUrl?: string;
  previewHtml?: string;
  kind?: DocumentSurfaceKind;
  slides?: SlideData[];
  /** The spec a generated deck was built from (see shared/deck.ts). */
  deck?: DeckSpec;
  status?: WorkProductStatus;
  warnings?: string[];
}

export interface DocumentSurfaceProduct {
  id?: string;
  title?: string;
  status?: WorkProductStatus;
  sourceCount?: number;
  warnings?: string[];
  workProduct?: GeneratedWorkProduct | null;
}

const DOCUMENT_SURFACE_EXTS = new Set([
  'md',
  'markdown',
  'txt',
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  // `export_research_package` emits citations as .bib (BibTeX) and .ris. They are
  // plain text and were being dropped from the reader, so a citations-only export
  // showed one .txt file and silently hid the other two.
  'bib',
  'ris'
]);

export function documentExtension(name: string) {
  return (name.split('.').pop() || '').toLowerCase();
}

export function isDocumentSurfaceFile(name: string) {
  return DOCUMENT_SURFACE_EXTS.has(documentExtension(name));
}

export function baseName(name: string) {
  return name.split(/[\\/]/).pop() || name;
}

export function fileTypeLabel(name: string, kind?: DocumentSurfaceKind) {
  if (kind === 'report') return 'Document';
  if (kind === 'slides') return 'Slides';
  const ext = documentExtension(name) || 'file';
  return ext.length <= 4 ? ext.toUpperCase() : ext;
}

const TEXT_DOCUMENT_EXTS = new Set(['md', 'markdown', 'txt', 'csv', 'bib', 'ris']);

/** The artifact's readable files, as items the reader and studio can draw. */
export function artifactDocumentItems(resolved: ResolvedArtifact): DocumentSurfaceItem[] {
  return resolved.visibleFiles.flatMap(([path, content]): DocumentSurfaceItem[] => {
    if (!isDocumentSurfaceFile(path)) return [];
    const ext = documentExtension(path);
    const binary = isDataUrlFile(content);
    const deck = ext === 'pptx' ? deckSpec(resolved.artifact.files[specPathFor(path)]) : null;
    const slides = deck?.slides.length ? deck.slides.map((slide) => ({ title: slide.title, content: slide.bullets, notes: slide.notes ?? null, layout: slide.layout })) : null;
    return [{
      id: path,
      name: path,
      title: baseName(path),
      dataUrl: binary ? content : undefined,
      content: !binary && TEXT_DOCUMENT_EXTS.has(ext) ? content : undefined,
      previewHtml: resolved.artifact.files[viewerPathFor(path)] || '',
      kind: slides ? 'slides' : ext === 'md' || ext === 'markdown' ? 'report' : 'document',
      ...(slides ? { slides } : {}),
      ...(deck ? { deck } : {}),
      status: resolved.artifact.workProduct?.status,
      warnings: resolved.artifact.workProduct?.warnings
    }];
  });
}

/** The deck spec saved beside a generated .pptx, if there is one. */
function deckSpec(raw: string | undefined): DeckSpec | null {
  if (!raw) return null;
  try {
    const spec = JSON.parse(raw) as { kind?: string; deck?: Record<string, unknown> };
    // Re-normalized: decks saved by older builds have no layouts or theme.
    return spec.kind === 'deck' && spec.deck ? normalizeDeck(spec.deck) : null;
  } catch {
    return null;
  }
}
