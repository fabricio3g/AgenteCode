// Which viewer shows a document. One decision, shared by the chat reader and
// the Artifacts studio, so a file never opens natively in one place and as a
// bare HTML fallback in the other.

import { getViewerKind } from '$lib/utils/doc-utils';
import { documentExtension, type DocumentSurfaceItem } from './document-surface';

export type DocumentViewerKind =
  | 'pptx'
  | 'slides'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'markdown'
  | 'text'
  | 'image'
  | 'html'
  | 'pptx-missing'
  | 'unsupported';

export function isMarkdownDocument(doc: DocumentSurfaceItem | null | undefined): boolean {
  if (!doc) return false;
  const ext = documentExtension(doc.name);
  return doc.kind === 'report' || ext === 'md' || ext === 'markdown';
}

/**
 * Native viewers first; the generated `__viewer__` HTML is only a fallback for
 * files nothing native can draw (a .pptx without its deck spec, say).
 */
export function pickDocumentViewer(doc: DocumentSurfaceItem | null | undefined): DocumentViewerKind {
  if (!doc) return 'unsupported';
  const source = documentSource(doc);
  const kind = getViewerKind(doc.name, doc.type || '');
  if ((documentExtension(doc.name) === 'html' || documentExtension(doc.name) === 'htm') && (doc.previewHtml || doc.content || source)) return 'html';
  // A real .pptx is drawn from the file itself; the saved deck outline is
  // only the fallback when there are no bytes to draw.
  if (kind === 'pptx' && doc.dataUrl) return 'pptx';
  if (doc.kind === 'slides' && doc.slides?.length) return 'slides';
  if (source && (kind === 'pdf' || kind === 'docx' || kind === 'xlsx')) return kind;
  if (isMarkdownDocument(doc) && doc.content !== undefined) return 'markdown';
  if (kind === 'text' && source) return 'text';
  if (kind === 'image' && source) return 'image';
  if (doc.previewHtml) return 'html';
  if (kind === 'pptx') return 'pptx-missing';
  return 'unsupported';
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}

/** A data URL for the document's bytes, whether it arrived binary or as text. */
export function documentSource(doc: DocumentSurfaceItem | null | undefined): string {
  if (!doc) return '';
  if (doc.dataUrl) return doc.dataUrl;
  if (doc.content === undefined) return '';
  const ext = documentExtension(doc.name);
  const mime = ext === 'csv' ? 'text/csv' : ext === 'md' || ext === 'markdown' ? 'text/markdown' : 'text/plain';
  return `data:${mime};charset=utf-8;base64,${utf8Base64(doc.content)}`;
}
