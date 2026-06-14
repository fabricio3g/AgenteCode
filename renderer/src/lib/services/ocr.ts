// Chatea - OCR Engine (Tesseract.js + PDF.js)
// Ported from legacy web/components/ocr.js

interface OcrResult {
  text: string;
  confidence: number;
}

interface PdfPageResult {
  pageNum: number;
  text: string;
}

interface PdfOcrResult {
  pages: PdfPageResult[];
  fullText: string;
}

interface DocxImageResult {
  name: string;
  text: string;
}

interface DocxOcrResult {
  images: DocxImageResult[];
  fullText: string;
}

const TESSERACT_WORKER_PATH = new URL('tesseract.js/dist/worker.min.js', import.meta.url).href;
const TESSERACT_CORE_PATH = new URL('tesseract.js-core/tesseract-core.wasm.js', import.meta.url).href;

type OcrProgressPhase = 'rendering' | 'recognizing' | 'done';

function emitProgress(page: number, total: number, phase: OcrProgressPhase) {
  window.dispatchEvent(
    new CustomEvent('ocr-progress', { detail: { page, total, phase } })
  );
}

// Minimal ZIP reader — extracts images from DOCX word/media/
async function extractZipImages(
  arrayBuffer: ArrayBuffer
): Promise<{ name: string; blob: Blob }[]> {
  const images: { name: string; blob: Blob }[] = [];
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.length;

  // Find End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  for (let i = len - 22; i >= 0 && i >= len - 65557; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return images;

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdEntries = view.getUint16(eocdOffset + 10, true);
  const imageExts = /\.(png|jpe?g|gif|bmp)$/i;
  let offset = cdOffset;

  for (let i = 0; i < cdEntries; i++) {
    if (offset + 46 > len) break;
    if (view.getUint32(offset, true) !== 0x02014b50) break;

    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);

    if (name.startsWith('word/media/') && imageExts.test(name)) {
      const lh = localHeaderOffset;
      if (lh + 30 <= len) {
        const lhNameLen = view.getUint16(lh + 26, true);
        const lhExtraLen = view.getUint16(lh + 28, true);
        const compSize = view.getUint32(lh + 18, true);
        const compMethod = view.getUint16(lh + 8, true);
        const dataStart = lh + 30 + lhNameLen + lhExtraLen;

        if (dataStart + compSize <= len) {
          const raw = bytes.slice(dataStart, dataStart + compSize);
          let blob: Blob | null = null;
          if (compMethod === 0) {
            blob = new Blob([raw]);
          } else if (compMethod === 8) {
            try {
              const ds = new DecompressionStream('deflate-raw');
              const writer = ds.writable.getWriter();
              void writer.write(raw);
              void writer.close();
              const reader = ds.readable.getReader();
              const chunks: BlobPart[] = [];
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
              }
              blob = new Blob(chunks);
            } catch {
              continue;
            }
          }
          if (blob) {
            images.push({ name: name.split('/').pop() || name, blob });
          }
        }
      }
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return images;
}

class OcrEngine {
  private worker: { recognize: (imageSource: string | Blob | File | HTMLCanvasElement) => Promise<{ data: { text: string; confidence: number } }>; reinitialize: (lang: string) => Promise<void>; terminate: () => Promise<void> } | null = null;
  private ready = false;
  private busy = false;
  private lang = 'eng';

  async init(lang = 'eng') {
    if (this.worker && this.lang === lang) return;
    if (this.worker && this.lang !== lang) {
      await this.worker.reinitialize(lang);
      this.lang = lang;
      return;
    }
    const Tesseract = await import('tesseract.js');
    this.worker = await Tesseract.createWorker(lang, undefined, {
      workerBlobURL: false,
      workerPath: TESSERACT_WORKER_PATH,
      corePath: TESSERACT_CORE_PATH,
    }) as unknown as typeof this.worker;
    this.lang = lang;
    this.ready = true;
  }

  async recognize(imageSource: string | Blob | File): Promise<OcrResult> {
    try {
      this.busy = true;
      emitProgress(0, 1, 'recognizing');
      await this.init();
      const result = await this.worker!.recognize(imageSource);
      emitProgress(1, 1, 'done');
      return { text: result.data.text, confidence: result.data.confidence };
    } catch (err: unknown) {
      console.error('[OcrEngine] recognize failed:', err);
      return { text: '', confidence: 0 };
    } finally {
      this.busy = false;
    }
  }

  async ocrPdfPages(file: File): Promise<PdfOcrResult> {
    try {
      this.busy = true;
      // Dynamic import to keep bundle small until needed
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).href;

      await this.init();
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const total = pdf.numPages;
      const pages: PdfPageResult[] = [];

      for (let i = 1; i <= total; i++) {
        emitProgress(i, total, 'rendering');
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 });

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;

        emitProgress(i, total, 'recognizing');
        const result = await this.worker!.recognize(canvas);
        pages.push({ pageNum: i, text: result.data.text });
      }

      emitProgress(total, total, 'done');
      return { pages, fullText: pages.map((p) => p.text).join('\n\n') };
    } catch (err: unknown) {
      console.error('[OcrEngine] ocrPdfPages failed:', err);
      return { pages: [], fullText: '' };
    } finally {
      this.busy = false;
    }
  }

  // Extract text from PDF using PDF.js text layer (no OCR needed for digital PDFs)
  async extractPdfText(file: File): Promise<{ text: string; pageCount: number }> {
    try {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).href;

      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const pageCount = pdf.numPages;
      const texts: string[] = [];

      for (let i = 1; i <= pageCount; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ('str' in item ? (item as { str: string }).str : ''))
          .join(' ');
        texts.push(pageText);
      }

      return { text: texts.join('\n\n'), pageCount };
    } catch (err: unknown) {
      console.error('[OcrEngine] extractPdfText failed:', err);
      return { text: '', pageCount: 0 };
    }
  }

  async ocrDocxImages(file: File): Promise<DocxOcrResult> {
    try {
      this.busy = true;
      await this.init();

      const arrayBuffer = await file.arrayBuffer();
      const entries = await extractZipImages(arrayBuffer);
      const total = entries.length;
      const images: DocxImageResult[] = [];

      for (let i = 0; i < total; i++) {
        emitProgress(i + 1, total, 'recognizing');
        const url = URL.createObjectURL(entries[i].blob);
        try {
          const result = await this.worker!.recognize(url);
          images.push({ name: entries[i].name, text: result.data.text });
        } finally {
          URL.revokeObjectURL(url);
        }
      }

      emitProgress(total, total, 'done');
      return { images, fullText: images.map((img) => img.text).join('\n\n') };
    } catch (err: unknown) {
      console.error('[OcrEngine] ocrDocxImages failed:', err);
      return { images: [], fullText: '' };
    } finally {
      this.busy = false;
    }
  }

  isScannedPdf(extractedText: string, pageCount: number): boolean {
    if (!pageCount || pageCount <= 0) return false;
    return extractedText.length / pageCount < 100;
  }

  async terminate() {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.ready = false;
      this.busy = false;
    }
  }

  getStatus() {
    return { ready: this.ready, lang: this.lang, busy: this.busy };
  }
}

const ocrEngine = new OcrEngine();

/**
 * Process a file for text extraction — auto-selects best method:
 * - Images → OCR
 * - PDFs → parser text extraction
 * - DOCX → OCR embedded images
 * - Text files → direct read
 */
export async function extractTextFromFile(file: File): Promise<string> {
  const type = file.type;
  const name = file.name.toLowerCase();

  // Plain text files
  if (
    type.startsWith('text/') ||
    name.endsWith('.txt') ||
    name.endsWith('.md') ||
    name.endsWith('.csv') ||
    name.endsWith('.json') ||
    name.endsWith('.xml') ||
    name.endsWith('.html') ||
    name.endsWith('.rtf')
  ) {
    return await file.text();
  }

  // Images → OCR
  if (type.startsWith('image/')) {
    const result = await ocrEngine.recognize(file);
    return result.text;
  }

  // PDFs → parser only (no OCR fallback)
  if (type === 'application/pdf' || name.endsWith('.pdf')) {
    const { text } = await ocrEngine.extractPdfText(file);
    return text;
  }

  // DOCX → extract text + OCR embedded images
  if (
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    const ocrResult = await ocrEngine.ocrDocxImages(file);
    return ocrResult.fullText;
  }

  return '';
}
