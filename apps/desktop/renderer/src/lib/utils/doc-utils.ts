import { FileText, FileSpreadsheet, FileCode, FileImage, FileArchive, FileMusic, FilePlay, Image, File, Presentation } from 'lucide-svelte';
import { dataUrlMime, dataUrlToBytes } from './artifact-files';

export type ViewerKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'image' | 'unknown';

const imageExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico']);
const textExts = new Set(['txt', 'md', 'csv', 'bib', 'ris', 'json', 'xml', 'html', 'htm', 'rtf', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'env', 'log']);
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

const archiveExts = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
const audioExts = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac']);
const videoExts = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const sheetExts = new Set(['xls', 'xlsx', 'csv', 'tsv', 'ods']);
const docExts = new Set(['doc', 'docx', 'odt', 'rtf', 'pdf']);
const slideExts = new Set(['ppt', 'pptx', 'odp']);
const markupExts = new Set(['json', 'xml', 'html', 'htm']);

type FileIcon = typeof FileText;

/** Extension groups in priority order — first match wins. */
const EXT_ICON_GROUPS: Array<[exts: Set<string>, icon: FileIcon]> = [
  [sheetExts, FileSpreadsheet],
  [slideExts, Presentation],
  [docExts, FileText],
  [archiveExts, FileArchive],
  [audioExts, FileMusic],
  [videoExts, FilePlay],
  [imageExts, FileImage],
  [codeExts, FileCode],
  [markupExts, FileCode],
  [textExts, FileText]
];

/** Viewer-kind fallback when the extension is unknown but the mime is known. */
const KIND_ICONS: Record<ViewerKind, FileIcon> = {
  pdf: FileText,
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
  text: FileText,
  image: Image,
  unknown: File
};

export function getFileIcon(name: string, type = ''): FileIcon {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  for (const [exts, icon] of EXT_ICON_GROUPS) {
    if (exts.has(ext)) return icon;
  }
  if (type.startsWith('audio/')) return FileMusic;
  if (type.startsWith('video/')) return FilePlay;
  if (type.startsWith('image/')) return FileImage;
  if (type.startsWith('text/')) return FileText;
  return KIND_ICONS[getViewerKind(name, type)];
}

/**
 * The accent a file's tile carries, matching the artifact cards' kind palette:
 * documents blue, sheets green, decks amber, pdfs red, media violet, code and
 * web sky. Same priority order as `EXT_ICON_GROUPS` — first match wins.
 */
const EXT_ACCENT_GROUPS: Array<[exts: Set<string>, accent: string]> = [
  [new Set(['pdf']), 'var(--accent-red)'],
  [sheetExts, 'var(--accent-green)'],
  [slideExts, 'var(--accent-amber)'],
  [docExts, 'var(--chart-1)'],
  [codeExts, 'var(--accent-sky)'],
  [markupExts, 'var(--accent-sky)'],
  [imageExts, 'var(--accent-violet)'],
  [archiveExts, 'var(--accent-violet)'],
  [audioExts, 'var(--accent-violet)'],
  [videoExts, 'var(--accent-violet)'],
  [textExts, 'var(--chart-1)']
];

export function fileAccent(name: string, type = ''): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  for (const [exts, accent] of EXT_ACCENT_GROUPS) {
    if (exts.has(ext)) return accent;
  }
  if (type.startsWith('audio/') || type.startsWith('video/') || type.startsWith('image/')) return 'var(--accent-violet)';
  return 'var(--chart-1)';
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
