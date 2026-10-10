import type { Attachment } from '$lib/types/chat';
import type { IndexedDocument } from '$lib/types/bridge';
import { ingestionFileType, type DocumentIngestPayload, type ExtractedFileText } from '$shared/document-ingestion';

export interface AttachmentIngestionDeps {
  visionAvailable: () => Promise<boolean>;
  dataUrl: (file: Blob) => Promise<string>;
  writeFile: (name: string, bytes: Uint8Array) => Promise<string>;
  ingest: (payload: DocumentIngestPayload) => Promise<IndexedDocument>;
  extractFallback: (file: File) => Promise<ExtractedFileText>;
}

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** One ingestion path for dropped/picked files; dependencies keep it testable. */
export async function ingestAttachment(file: File, attachment: Attachment, chatId: string, deps: AttachmentIngestionDeps): Promise<Attachment> {
  try {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('Files over 512 MB must be split before attaching.');
    const { kind, mime } = ingestionFileType(file.name, file.type);
    attachment.type = mime;
    attachment.kind = kind === 'image' ? 'image' : 'document';
    if (kind === 'image') {
      attachment.base64 = await deps.dataUrl(file);
      attachment.visionReady = await deps.visionAvailable();
      if (attachment.visionReady) {
        attachment.processingMode = 'vision'; attachment.status = 'ready';
        return attachment;
      }
    } else if (kind === 'document') {
      attachment.data = await deps.dataUrl(file);
    }
    attachment.processingMode = kind === 'image' ? 'ocr' : kind === 'audio' || kind === 'video' ? 'transcription' : 'document_text';
    const filePath = await deps.writeFile(file.name, new Uint8Array(await file.arrayBuffer()));
    const payload: DocumentIngestPayload = { file_path: filePath, chat_id: chatId, name: file.name };
    let doc: IndexedDocument;
    if (kind === 'image') {
      const result = await deps.extractFallback(file);
      if (!result.text.trim()) throw new Error('No readable text in this image.');
      attachment.ocrText = result.text;
      doc = await deps.ingest({ ...payload, extracted_text: result.text, extraction_method: result.method, extraction_warning: result.warning });
    } else {
      try { doc = await deps.ingest(payload); }
      catch (error) {
        // Whisper errors need speech setup/retry, not a binary-to-text fallback.
        if (kind === 'audio' || kind === 'video') throw error;
        const result = await deps.extractFallback(file).catch((fallbackError) => {
          throw new Error(`${error instanceof Error ? error.message : String(error)} ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
        });
        if (!result.text.trim()) throw new Error('No readable content found, including after OCR.');
        attachment.ocrText = result.text;
        doc = await deps.ingest({ ...payload, extracted_text: result.text, extraction_method: result.method, extraction_warning: result.warning });
      }
    }
    attachment.docId = doc.id;
    // The complete extraction is indexed and available to read_document.
    // Keep only a bounded inline hint, so a large scan cannot overflow a
    // text-only model's context before it can use the document reader.
    if (attachment.ocrText && attachment.ocrText.length > 6000) {
      attachment.ocrText = `${attachment.ocrText.slice(0, 6000)}\n[Excerpt only; use read_document for the complete indexed file.]`;
    }
    attachment.warning = doc.extraction_warning;
    if (doc.extraction_method === 'ocr') attachment.processingMode = 'ocr';
    if (doc.extraction_method === 'transcription') attachment.processingMode = 'transcription';
    attachment.status = 'ready';
  } catch (error) {
    attachment.status = 'error';
    attachment.error = error instanceof Error ? error.message : String(error);
  }
  return attachment;
}
