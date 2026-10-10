import { ingestionFileType, type DocumentIngestPayload, type ExtractionMethod } from '../shared/document-ingestion.ts';
import { convertFileToMarkdown } from './document-markdown.ts';

export type IngestionText = { text: string; fileType: string; method: ExtractionMethod; warning?: string };
const MAX_EXTRACTED_CHARS = 8_000_000;

/** Keep media transcription local/configured; the chat model need not accept audio. */
export async function extractIngestionText(filePath: string, supplied: Pick<DocumentIngestPayload, 'extracted_text' | 'extraction_method' | 'extraction_warning'> = {}): Promise<IngestionText> {
  const { kind, mime } = ingestionFileType(filePath);
  let result: IngestionText;
  if (supplied.extracted_text !== undefined) {
    if (typeof supplied.extracted_text !== 'string' || !['ocr', 'transcription', 'parser'].includes(supplied.extraction_method || '')) {
      throw new Error('Extracted file text requires a valid extraction_method.');
    }
    result = {
      text: supplied.extracted_text,
      fileType: kind === 'document' ? filePath.split('.').pop()!.toLowerCase() : kind,
      method: supplied.extraction_method!, warning: supplied.extraction_warning,
    };
  } else if (kind === 'audio' || kind === 'video') {
    const { transcribeMediaFile } = await import('./voice/media-transcription.ts');
    result = { text: await transcribeMediaFile(filePath, mime), fileType: kind, method: 'transcription',
      warning: kind === 'video' ? 'Only the audio track was transcribed; visual content was not analyzed.' : undefined };
  } else if (kind === 'image') {
    throw new Error('This image needs OCR in the attachment reader.');
  } else {
    const converted = await convertFileToMarkdown(filePath);
    result = { text: converted.markdown, fileType: converted.fileType, method: 'parser', warning: converted.warning };
  }
  result.text = result.text.replace(/\u0000/g, '').trim();
  if (!result.text) throw new Error('No readable content found. The file may be empty, encrypted, or need OCR.');
  if (result.text.length > MAX_EXTRACTED_CHARS) throw new Error('Extracted content exceeds 8 million characters. Split the document into smaller files.');
  return result;
}
