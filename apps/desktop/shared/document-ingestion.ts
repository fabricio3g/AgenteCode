/** The same file classification is used at upload, extraction and indexing. */
export type ExtractionMethod = 'parser' | 'ocr' | 'transcription';
export type IngestFileKind = 'image' | 'audio' | 'video' | 'document';

/** Added only on turns with ingested documents, leaving ordinary chat lean. */
export const INGESTED_DOCUMENT_GUIDANCE = 'For work based on uploads, read each relevant source with read_document/extract_tables and continue truncated pages, sheets or slides with range before writing. Indexed files include structured documents, OCR text and Whisper transcripts. Preserve numbers, units, dates, names and table headers; use calculator for derived totals. Cite the real filename plus page, sheet/row, slide or transcript timestamp; never invent web URLs for uploads. Carry reading warnings, unreadable pages and audio-only video coverage into limitations. Distinguish source facts from conclusions. Deliver requested files with create_work_product/create_document/create_spreadsheet/create_presentation/create_pdf, populated from these sources.';

const MEDIA_MIMES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  avif: 'image/avif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
};

export function ingestionFileType(name: string, mime = ''): { kind: IngestFileKind; mime: string } {
  const ext = name.toLowerCase().split('.').pop() || '';
  const resolved = mime && mime !== 'application/octet-stream' ? mime : (MEDIA_MIMES[ext] || 'application/octet-stream');
  const kind = resolved.startsWith('image/') ? 'image'
    : resolved.startsWith('audio/') ? 'audio'
    : resolved.startsWith('video/') ? 'video' : 'document';
  return { kind, mime: resolved };
}

export type ExtractedFileText = {
  text: string;
  method: ExtractionMethod;
  warning?: string;
};

/** Fallback text still belongs to the original stored file, with its real type. */
export type DocumentIngestPayload = {
  file_path: string;
  chat_id: string;
  message_id?: string;
  name?: string;
  chunk_size?: number;
  extracted_text?: string;
  extraction_method?: ExtractionMethod;
  extraction_warning?: string;
};
