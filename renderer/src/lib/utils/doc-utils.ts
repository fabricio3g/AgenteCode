import { FileText, FileSpreadsheet, Image, File, Presentation } from 'lucide-svelte';
import { dataUrlMime, dataUrlToBytes } from './artifact-files';

export type ViewerKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'image' | 'unknown';

const imageExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico']);
const textExts = new Set(['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'rtf', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'env', 'log']);
const codeExts = new Set(['js', 'ts', 'py', 'rb', 'rs', 'go', 'java', 'c', 'cpp', 'cs', 'h', 'hpp', 'php', 'swift', 'kt', 'scala', 'sh', 'bash', 'zsh', 'pl', 'lua', 'r', 'sql', 'graphql', 'css', 'scss', 'less', 'sass', 'styl']);

export function getViewerKind(name: string, type = ''): ViewerKind {
  const ext = name.split('.').pop()?.toLowerCase() || '';

  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (ext === 'docx' || type.includes('wordprocessingml')) return 'docx';
  if (ext === 'xlsx' || type.includes('spreadsheetml')) return 'xlsx';
  if (ext === 'pptx' || type.includes('presentationml')) return 'pptx';
  if (imageExts.has(ext) || type.startsWith('image/')) return 'image';
  if (textExts.has(ext) || codeExts.has(ext) || type.startsWith('text/')) return 'text';
  return 'unknown';
}

export function getFileIcon(name: string, type = '') {
  const kind = getViewerKind(name, type);
  switch (kind) {
    case 'pdf': return FileText;
    case 'docx': return FileText;
    case 'xlsx': return FileSpreadsheet;
    case 'pptx': return Presentation;
    case 'image': return Image;
    case 'text': return FileText;
    default: return File;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function downloadFromSrc(src: string, name: string) {
  try {
    const response = await fetch(src);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error('[downloadFromSrc] Download failed:', err);
  }
}

export function downloadFromDataUrl(dataUrl: string, name: string) {
  try {
    const bytes = dataUrlToBytes(dataUrl);
    const mime = dataUrlMime(dataUrl);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([buffer], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error('[downloadFromDataUrl] Download failed:', err);
  }
}
