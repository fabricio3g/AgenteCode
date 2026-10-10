import { describe, expect, it, vi } from 'vitest';
import { ingestAttachment, type AttachmentIngestionDeps } from './attachment-ingestion';
import { ingestionFileType } from '$shared/document-ingestion';
import type { Attachment } from '$lib/types/chat';

function setup(overrides: Partial<AttachmentIngestionDeps> = {}) {
  const deps: AttachmentIngestionDeps = {
    visionAvailable: vi.fn(async () => false),
    dataUrl: vi.fn(async () => 'data:application/octet-stream;base64,YQ=='),
    writeFile: vi.fn(async () => '/tmp/source.pdf'),
    ingest: vi.fn(async (payload) => ({ id: 'doc-1', source: payload.name!, file_type: 'pdf', chunk_count: 1, char_count: 30,
      extraction_method: payload.extraction_method || 'parser', extraction_warning: payload.extraction_warning })),
    extractFallback: vi.fn(async () => ({ text: '## Page 1\n\nReceipt total 42', method: 'ocr' as const })),
    ...overrides,
  };
  const attachment: Attachment = { id: 'a-1', name: 'source.pdf', size: 1, type: 'application/pdf', status: 'processing' };
  return { deps, attachment };
}

describe('attachment ingestion', () => {
  it('indexes a structured file with its original name', async () => {
    const { deps, attachment } = setup();
    const result = await ingestAttachment(new File(['x'], 'Sales.xlsx'), attachment, 'chat-1', deps);
    expect(result).toMatchObject({ docId: 'doc-1', status: 'ready', processingMode: 'document_text' });
    expect(deps.ingest).toHaveBeenCalledWith({ file_path: '/tmp/source.pdf', chat_id: 'chat-1', name: 'Sales.xlsx' });
    expect(deps.extractFallback).not.toHaveBeenCalled();
  });

  it('indexes OCR against the same stored PDF when native parsing fails', async () => {
    const { deps, attachment } = setup();
    vi.mocked(deps.ingest).mockRejectedValueOnce(new Error('PDF contains a scan'));
    const result = await ingestAttachment(new File(['x'], 'scan.pdf'), attachment, 'chat-1', deps);
    expect(deps.ingest).toHaveBeenLastCalledWith({ file_path: '/tmp/source.pdf', chat_id: 'chat-1', name: 'scan.pdf',
      extracted_text: '## Page 1\n\nReceipt total 42', extraction_method: 'ocr', extraction_warning: undefined });
    expect(result).toMatchObject({ status: 'ready', processingMode: 'ocr', docId: 'doc-1' });
  });

  it('reads image text with OCR only when vision is unavailable', async () => {
    const { deps, attachment } = setup();
    const image = new File(['image'], 'scan.PNG'); // OS may omit the MIME type.
    expect((await ingestAttachment(image, attachment, 'chat-1', deps))).toMatchObject({ type: 'image/png', kind: 'image', status: 'ready', docId: 'doc-1' });
    expect(deps.extractFallback).toHaveBeenCalledOnce();
    const vision = setup({ visionAvailable: async () => true });
    expect((await ingestAttachment(image, vision.attachment, 'chat-1', vision.deps))).toMatchObject({ processingMode: 'vision', status: 'ready' });
    expect(vision.deps.extractFallback).not.toHaveBeenCalled();
  });

  it('does not report an image as ready when OCR finds nothing', async () => {
    const { deps, attachment } = setup({ extractFallback: async () => ({ text: '', method: 'ocr' }) });
    expect((await ingestAttachment(new File(['x'], 'scan.png'), attachment, 'chat-1', deps)).status).toBe('error');
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it('routes recordings to transcription, keeps warnings, and never decodes failed audio as text', async () => {
    const { deps, attachment } = setup({ ingest: vi.fn(async () => ({ id: 'd', source: 'talk.mp4', file_type: 'video',
      extraction_method: 'transcription' as const, extraction_warning: 'Only the audio track was read', chunk_count: 1, char_count: 100 })) });
    expect(await ingestAttachment(new File(['x'], 'talk.mp4'), attachment, 'chat-1', deps)).toMatchObject({ status: 'ready',
      processingMode: 'transcription', warning: 'Only the audio track was read' });
    vi.mocked(deps.ingest).mockRejectedValueOnce(new Error('Install Whisper in Settings'));
    expect(await ingestAttachment(new File(['x'], 'talk.mp3'), attachment, 'chat-1', deps)).toMatchObject({ status: 'error', error: 'Install Whisper in Settings' });
    expect(deps.extractFallback).not.toHaveBeenCalled();
  });

  it('shows failure when fallback extraction works but indexing fails', async () => {
    const { deps, attachment } = setup({ ingest: vi.fn(async () => { throw new Error('Disk full'); }) });
    expect(await ingestAttachment(new File(['x'], 'scan.pdf'), attachment, 'chat-1', deps)).toMatchObject({ status: 'error', error: 'Disk full' });
  });

  it('indexes the complete OCR while keeping its inline context bounded', async () => {
    const text = 'Receipt facts. '.repeat(1000);
    const { deps, attachment } = setup({ extractFallback: async () => ({ text, method: 'ocr' }) });
    const result = await ingestAttachment(new File(['x'], 'scan.png'), attachment, 'chat-1', deps);
    expect(vi.mocked(deps.ingest).mock.calls[0][0].extracted_text).toBe(text);
    expect(result.ocrText!.length).toBeLessThan(6100);
    expect(result.ocrText).toContain('read_document');
  });

  it('classifies extension-only audio and preserves an explicit WebM audio MIME', () => {
    expect(ingestionFileType('VOICE.M4A')).toEqual({ kind: 'audio', mime: 'audio/mp4' });
    expect(ingestionFileType('clip.webm', 'audio/webm')).toEqual({ kind: 'audio', mime: 'audio/webm' });
    expect(ingestionFileType('sheet.xlsx')).toMatchObject({ kind: 'document' });
  });
});
