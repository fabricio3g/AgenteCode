import { readArrayBuffer } from './viewer-source';

/**
 * DOCX page rendering, decoupled from the component that displays it.
 *
 * Kept as a pure module so the page-count math, the zoom clamp and the
 * "did the render land back on the current source" guard are unit-testable
 * without a live Svelte component, and so DocxViewer stays a template.
 *
 * Why docx-preview: it renders the document's real A4 pages, page breaks,
 * headers/footers and fonts. The previous mammoth pipeline produced one
 * endless HTML column that the app then had to style itself.
 */

/** Scale pages down to the reader column; never scale a small page up. */
export function fitZoom(pageWidth: number, availableWidth: number): number {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || availableWidth <= 0) return 1;
  return Math.min(1, availableWidth / pageWidth);
}

/** Pages the library actually appended, counted from the DOM it filled. */
export function countRenderedPages(host: ParentNode): number {
  return host.querySelectorAll('section.docx').length;
}

/**
 * Render `src` (a data: or fetchable URL) as paginated pages into `host` and
 * return the page count.
 *
 * The library's returned object is the parsed document (not an array of
 * pages), so the count comes from the rendered DOM instead.
 */
export async function loadDocxInto(source: string, filename: string, host: HTMLElement): Promise<number> {
  if (!/\.docx$/i.test(filename)) {
    throw new Error('Only DOCX preview is supported. Download this document to open it.');
  }
  const { renderAsync } = await import('docx-preview');
  const blob = new Blob([await readArrayBuffer(source, 'document')], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
  await renderAsync(blob, host, host, {
    // breakPages keeps the document's real page geometry and section breaks;
    // ignoreWidth/ignoreHeight would collapse pages back into one endless
    // column, which is the bug this viewer exists to fix.
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    inWrapper: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    useBase64URL: true
  });
  return countRenderedPages(host);
}
