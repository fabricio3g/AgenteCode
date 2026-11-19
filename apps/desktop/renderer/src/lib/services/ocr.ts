// Shared attachment/tool extraction. PDF pages are read first, then OCR'd only
// where needed; one worker is serialized across simultaneous uploads/tool calls.
import TESSERACT_WORKER_PATH from 'tesseract.js/dist/worker.min.js?url';
import TESSERACT_CORE_PATH from 'tesseract.js-core/tesseract-core.wasm.js?url';
import PDF_WORKER_PATH from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import ENGLISH_DATA_PATH from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';
import type { ExtractedFileText } from '$shared/document-ingestion';
import { ingestionFileType } from '$shared/document-ingestion';
import { extractPdfContent } from './pdf-ingestion';
import { pdfTextLines } from '$shared/pdf-text';
import JSZip from 'jszip';

let worker: Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function bounded<T>(task: Promise<T>, message: string, timeoutMs = 120_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([task, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer!); }
}

type ProgressPhase = 'rendering' | 'recognizing' | 'done' | 'error';
function progress(page: number, total: number, phase: ProgressPhase) {
  window.dispatchEvent(new CustomEvent('ocr-progress', { detail: { page, total, phase } }));
}

async function recognize(image: File | Blob | HTMLCanvasElement): Promise<string> {
  if (!worker) {
    const { createWorker } = await import('tesseract.js');
    // Language names stay strings: Tesseract 7's Lang[] initialization reads
    // the byte payload as a language name. A bundled directory uses its normal
    // supported path instead. Vite retains this asset's expected filename.
    const langPath = new URL('.', new URL(ENGLISH_DATA_PATH, window.location.href)).href;
    const initializing = createWorker('eng', undefined, {
      workerBlobURL: false, workerPath: TESSERACT_WORKER_PATH, corePath: TESSERACT_CORE_PATH,
      langPath, cacheMethod: 'none',
    });
    try { worker = await bounded(initializing, 'OCR engine initialization timed out. Try attaching the file again.'); }
    catch (error) {
      // A worker that comes up after its deadline must not outlive the upload.
      void initializing.then((late) => late.terminate(), () => {}).catch(() => {});
      throw error;
    }
  }
  try {
    return (await bounded(worker.recognize(image), 'OCR recognition timed out. Try a smaller image or split the PDF.')).data.text.trim();
  } catch (error) {
    const failed = worker; worker = null;
    void failed.terminate().catch(() => {});
    throw error;
  }
}

async function extractPdf(file: File): Promise<ExtractedFileText> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_PATH;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  try {
    const result = await extractPdfContent({
      pages: pdf.numPages,
      readPage: async (number) => {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        return pdfTextLines(content.items.flatMap((item) => 'str' in item
          ? [{ str: item.str, transform: item.transform, width: item.width }] : [])).join('\n');
      },
      recognizePage: async (number) => {
        progress(number, pdf.numPages, 'rendering');
        const page = await pdf.getPage(number);
        const base = page.getViewport({ scale: 1 });
        // Bound OCR canvas memory for posters/oversized pages, while ordinary
        // pages render at 2x for character recognition.
        const scale = Math.min(2, Math.sqrt(16_000_000 / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not render this PDF page for OCR.');
        try {
          // OCR has no animation frame to paint. Print intent makes PDF.js
          // render through microtasks even in a hidden/minimized app window.
          const rendering = page.render({ canvasContext: context, viewport, canvas, intent: 'print' });
          try { await bounded(rendering.promise, `Rendering PDF page ${number} timed out. Try exporting or splitting this PDF.`); }
          catch (error) { rendering.cancel(); throw error; }
          progress(number, pdf.numPages, 'recognizing');
          return await recognize(canvas);
        } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); }
      },
    });
    progress(pdf.numPages, pdf.numPages, 'done');
    return result;
  } finally { await pdf.destroy(); }
}

async function extract(file: File): Promise<ExtractedFileText> {
  const { kind } = ingestionFileType(file.name, file.type);
  if (kind === 'image') {
    progress(0, 1, 'recognizing');
    const text = await recognize(file);
    if (!text) throw new Error('No text recognized in this image. Select a vision model to analyze its visual content.');
    progress(1, 1, 'done');
    return { text, method: 'ocr', warning: 'OCR reads text only; visual details are not analyzed.' };
  }
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return extractPdf(file);
  if (kind === 'audio' || kind === 'video') throw new Error('Recording transcription requires the desktop app and a configured Whisper engine.');

  const { docKindOf, parseDocument } = await import('./agent-doc-reader');
  const type = docKindOf(file.name, file.type);
  if (!type) throw new Error('This format needs the desktop document reader.');
  if (/\.(rtf|html?|epub|od[stp])$/i.test(file.name)) throw new Error('This format needs the desktop structured document reader.');
  const bytes = await file.arrayBuffer();
  const doc = await parseDocument(file.name, bytes, file.type);
  let text = doc.units.map((unit) => {
    const tables = unit.tables.map((rows) => rows.map((row) => row.join('\t')).join('\n')).join('\n\n');
    return `## ${unit.label}\n\n${unit.text}${tables ? `\n\n${tables}` : ''}`;
  }).join('\n\n');
  let method: ExtractedFileText['method'] = 'parser';
  if (type === 'docx' && !doc.units.some((unit) => unit.text.trim() || unit.tables.length)) {
    const zip = await JSZip.loadAsync(bytes);
    const images = Object.values(zip.files).filter((entry) => /^word\/media\/.*\.(png|jpe?g|gif|bmp)$/i.test(entry.name));
    const sections: string[] = [];
    for (const [i, entry] of images.entries()) {
      progress(i + 1, images.length, 'recognizing');
      const recognized = await recognize(await entry.async('blob'));
      if (recognized) sections.push(`## Image ${i + 1}\n\n${recognized}`);
    }
    text = sections.join('\n\n'); method = 'ocr';
    progress(images.length, images.length, 'done');
  } else if (!doc.units.some((unit) => unit.text.trim() || unit.tables.length)) {
    throw new Error('No readable content in this document.');
  }
  if (!text.trim()) throw new Error('No readable content in this document.');
  return { text, method };
}

export function extractFileContent(file: File): Promise<ExtractedFileText> {
  const task = queue.then(() => extract(file));
  queue = task.catch(() => { progress(0, 0, 'error'); });
  return task;
}

/** Compatibility for tools that consume only text. Errors remain visible. */
export async function extractTextFromFile(file: File): Promise<string> {
  return (await extractFileContent(file)).text;
}
