import type { SlideData } from '$lib/types/tauri';
import type { GeneratedWorkProduct, WorkProductStatus } from '$lib/types/chat';

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
  'csv'
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
