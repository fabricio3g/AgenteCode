import type { ExtractedFileText } from '$shared/document-ingestion';

export interface PdfIngestionDeps {
  pages: number;
  readPage: (page: number) => Promise<string>;
  recognizePage: (page: number) => Promise<string>;
}

/** Read/OCR per page: a digital first page says nothing about later scans. */
export async function extractPdfContent(deps: PdfIngestionDeps): Promise<ExtractedFileText> {
  const sections: string[] = [];
  const empty: number[] = [];
  let usedOcr = false;
  for (let page = 1; page <= deps.pages; page++) {
    let text = (await deps.readPage(page)).trim();
    if (!/[\p{L}\p{N}]/u.test(text) || (text.match(/\uFFFD/g)?.length || 0) > text.length / 10) {
      // An OCR exception fails the upload; it must not silently omit a page.
      text = (await deps.recognizePage(page)).trim();
      usedOcr = true;
    }
    if (!text) empty.push(page);
    sections.push(`## Page ${page}\n\n${text || '[No readable text on this page]'}`);
  }
  if (!deps.pages || empty.length === deps.pages) throw new Error('No readable text found, including after OCR.');
  return {
    text: sections.join('\n\n'), method: usedOcr ? 'ocr' : 'parser',
    warning: empty.length ? `No text recognized on page${empty.length === 1 ? '' : 's'} ${empty.join(', ')}. Visual content on these pages was not analyzed.` : undefined,
  };
}
