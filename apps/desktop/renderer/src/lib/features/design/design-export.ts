/**
 * PNG and PDF export of a page. The renderer inlines the page (the same builder
 * the canvas and the agent's preview use) and asks main to render it in the
 * offline guest and save it through a save dialog; main checks the document,
 * clamps the width and writes the file.
 */
import { invoke } from '$lib/services/bridge';
import { buildPreviewHtml } from '$lib/utils/preview-builder';
import type { DesignManageRequest } from '$shared/design';

export const DEFAULT_EXPORT_WIDTH = 1440;

/** The single-file document of one page, or null when the page is missing or cannot be built. */
export function pageHtml(files: Record<string, string>, page: string): string | null {
  const source = files[page];
  if (source === undefined) return null;
  try { return buildPreviewHtml(source, files, page, true).html; } catch { return null; }
}

/** The width an export renders at: the frame asked about, else the board's widest default. */
export function exportWidthOf(frame: { width: number } | null | undefined): number {
  return frame && Number.isFinite(frame.width) && frame.width > 0 ? Math.round(frame.width) : DEFAULT_EXPORT_WIDTH;
}

export type ExportOutcome = 'saved' | 'cancelled' | 'failed';

/** Renders `page` and saves it as a PNG (full length, at `width`) or a PDF (one tall page). */
export async function exportRendered(chatId: string, files: Record<string, string>, page: string, kind: 'png' | 'pdf', width: number): Promise<ExportOutcome> {
  const html = pageHtml(files, page);
  if (!html) return 'failed';
  const request: DesignManageRequest = kind === 'png'
    ? { chatId, action: 'export_png', page, html, width }
    : { chatId, action: 'export_pdf', page, html, width };
  try {
    const result = await invoke<{ saved: boolean }>('design_manage', request);
    return result?.saved === false ? 'cancelled' : 'saved';
  } catch {
    return 'failed';
  }
}
