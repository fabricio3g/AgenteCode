/**
 * Pure helpers for exporting a page as a PNG or a PDF. The picture is made by
 * the offline render guest (`render.ts`); what is decided here is the file's
 * name, the width asked for and the PDF's page size, so each can be tested
 * without a window.
 */
import { exportFileName } from './workspace.ts';

const EXPORT_WIDTH = { min: 280, max: 2560, fallback: 1440 } as const;
/** Chromium prints one page up to 200 inches; a page taller than this is cut at 18000 CSS px (187.5 in). */
export const PDF_MAX_HEIGHT_PX = 18_000;
const PDF_MIN_HEIGHT_PX = 200;
const CSS_PX_PER_INCH = 96;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The width an export asks for, clamped to what the render guest allows. */
export function clampExportWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return EXPORT_WIDTH.fallback;
  return Math.min(EXPORT_WIDTH.max, Math.max(EXPORT_WIDTH.min, Math.round(value)));
}

/** "pricing-1440.png" for a frame, "pricing.pdf" for a page. */
export function exportImageName(page: string, ext: 'png' | 'pdf', width?: number): string {
  const stem = exportFileName(page).replace(/\.html$/, '');
  return width ? `${stem}-${width}.${ext}` : `${stem}.${ext}`;
}

/** One tall PDF page as wide as the frame and as tall as the content (inches, as Electron's printToPDF takes them). */
export function pdfPageSize(width: number, contentHeight: number): { width: number; height: number } {
  const height = Math.min(PDF_MAX_HEIGHT_PX, Math.max(PDF_MIN_HEIGHT_PX, Math.ceil(Number.isFinite(contentHeight) ? contentHeight : PDF_MIN_HEIGHT_PX)));
  return { width: clampExportWidth(width) / CSS_PX_PER_INCH, height: height / CSS_PX_PER_INCH };
}

/** The bytes of a rendered PNG; anything that is not a PNG is refused rather than written under a .png name. */
export function pngBytes(base64: unknown): Buffer {
  const bytes = typeof base64 === 'string' ? Buffer.from(base64, 'base64') : Buffer.alloc(0);
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('The page could not be rendered.');
  return bytes;
}

/** The bytes of a rendered PDF; refused unless they start with the PDF magic. */
export function pdfBytes(data: unknown): Buffer {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.alloc(0);
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('The page could not be rendered.');
  return bytes;
}
