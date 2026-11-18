import { appStore } from '$lib/stores/app.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { invoke } from '$lib/services/bridge';
import { createId } from '$lib/utils/id';
import type { Attachment as ChatAttachment } from '$lib/types/chat';
import type { Attachment } from '$shared/agente-protocol.gen';
import { canvasBoard as defaultBoard, type CanvasBoardStore } from './canvas-board.svelte';
import { asFractions, lineEndpoints, composePrompt, mergeDraft, planHandoff, type CanvasImage, type CanvasMark, type HandoffEntry } from './canvas-doc';

/**
 * The board's way out: render what the user drew, import it the same way any
 * other attachment is imported, and write the instruction into the composer.
 *
 * Nothing here has its own idea of how media reaches a model. Every PNG goes
 * through `agente_media_import` and comes back as a real `Attachment`, so the
 * daemon's content-addressed copy, the `allow_media` consent gate and the
 * provider's vision support all apply exactly as they do for a dropped file.
 */

const XML = /[<>&"']/g;
const escapeXml = (value: string): string => value.replace(XML, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);

/** Where a text mark sits in image pixels, from a size in image pixels. */
function labelFontSize(mark: CanvasMark): number {
  return Math.max(13, Math.round(Math.min(40, mark.width * 4)));
}

function markSvg(mark: CanvasMark): string {
  const color = escapeXml(mark.color);
  const stroke = `stroke="${color}" stroke-width="${mark.width}" stroke-linecap="round" stroke-linejoin="round"`;
  const box = `<rect x="${mark.x}" y="${mark.y}" width="${mark.w}" height="${mark.h}" rx="2" fill="none" ${stroke} />`;
  switch (mark.kind) {
    case 'rect':
      return box;
    case 'ellipse':
      return `<ellipse cx="${mark.x + mark.w / 2}" cy="${mark.y + mark.h / 2}" rx="${mark.w / 2}" ry="${mark.h / 2}" fill="none" ${stroke} />`;
    case 'highlight':
      return `<rect x="${mark.x}" y="${mark.y}" width="${mark.w}" height="${mark.h}" rx="2" fill="${color}" fill-opacity="0.28" />`;
    case 'blur':
      return `<rect x="${mark.x}" y="${mark.y}" width="${mark.w}" height="${mark.h}" rx="2" fill="#808080" fill-opacity="0.55" />`;
    case 'text':
      return `<text x="${mark.x}" y="${mark.y}" fill="${color}" font-size="${labelFontSize(mark)}" font-family="sans-serif" dominant-baseline="middle">${escapeXml(mark.text || '')}</text>`;
    case 'line': {
      const { start, end } = lineEndpoints(mark);
      return `<path d="M${start.x} ${start.y} L${end.x} ${end.y}" fill="none" ${stroke} />`;
    }
    case 'arrow': {
      const { start, end } = lineEndpoints(mark);
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const head = Math.max(10, mark.width * 3);
      const barb = (sign: number) => `M${end.x} ${end.y} L${end.x - head * Math.cos(angle + sign * 0.42)} ${end.y - head * Math.sin(angle + sign * 0.42)}`;
      return `<path d="M${start.x} ${start.y} L${end.x} ${end.y}" fill="none" ${stroke} />`
        + `<path d="${barb(-1)}" fill="none" ${stroke} />`
        + `<path d="${barb(1)}" fill="none" ${stroke} />`;
    }
    case 'freehand':
      return `<path d="${mark.points?.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ') ?? ''}" fill="none" ${stroke} />`;
  }
}

/**
 * One entry as a standalone SVG document.
 *
 * The image is inlined as a data URL, not linked: a rasterizer will not follow
 * a `file://` reference, and the board's marks are meaningless over an empty
 * rectangle. A blank board has no bitmap at all, so it paints the same white
 * paper the surface shows instead.
 */
export function entrySvg(image: CanvasImage, href: string | null, entry: HandoffEntry): string {
  const view = entry.box ?? { x: 0, y: 0, w: image.w, h: image.h };
  const width = Math.max(1, Math.round(view.w));
  const height = Math.max(1, Math.round(view.h));
  const base = href
    ? `<image href="${escapeXml(href)}" x="0" y="0" width="${image.w}" height="${image.h}" />`
    : `<rect x="0" y="0" width="${image.w}" height="${image.h}" fill="#ffffff" />`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${view.x} ${view.y} ${view.w} ${view.h}">`,
    base,
    entry.marks.map(markSvg).join(''),
    '</svg>'
  ].join('');
}

/** Rasterize an SVG document to PNG. Returns the base64 half of the data URL. */
async function rasterize(svg: string): Promise<string> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Could not render the canvas.'));
      element.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || 1;
    canvas.height = image.naturalHeight || 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not render the canvas.');
    context.drawImage(image, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** True when a full-resolution copy of the attachment is worth loading. */
export const PREVIEW_MAX_EDGE = 2048;

/**
 * One rendered piece of the board, in both shapes the app needs.
 *
 * The daemon hands back a filesystem `Attachment`, which is all the Code
 * composer needs. Home's composer keeps a browser-side one instead: a data URL
 * it can show and send. The rendered PNG is already in hand here, so both ride
 * along and neither composer has to re-read the file.
 */
export interface ExportedMedia {
  attachment: Attachment;
  dataUrl: string;
}

interface HandoffResult {
  media: ExportedMedia[];
  prompt: string;
}

/**
 * Render the board and import every piece of it.
 *
 * Fails loudly rather than silently: a partial handoff would send the agent a
 * crop it cannot match to an instruction, which is worse than sending nothing.
 *
 * Two headers: an annotated screenshot and a drawing are not the same thing to
 * ask a model to read, so a board made from scratch gets its own wording. A
 * board holding both keeps the screenshot wording, which still fits the images.
 */
async function exportBoard(header: string, boardHeader: string, empty: string, canvasBoard: CanvasBoardStore = defaultBoard): Promise<HandoffResult> {
  const doc = canvasBoard.doc;
  const plan = planHandoff(doc);
  if (!plan.overview.length) return { media: [], prompt: '' };

  const previews = new Map<string, string>();
  /** Null for a blank board: there is no imported copy to read. */
  const load = async (image: CanvasImage): Promise<string | null> => {
    if (!image.path) return null;
    const path = image.path;
    const cached = previews.get(path);
    if (cached) return cached;
    const value = await invoke<string | null>('agente_media_preview', { path, maxSize: PREVIEW_MAX_EDGE });
    if (!value) throw new Error(`Could not read ${image.name}.`);
    previews.set(path, value);
    return value;
  };

  const media: ExportedMedia[] = [];
  const overviewPaths: string[] = [];
  let hasBitmap = false;
  const points: Array<{ label: string; kind: CanvasMark['kind']; box: ReturnType<typeof asFractions>; path: string }> = [];

  const importEntry = async (image: CanvasImage, entry: HandoffEntry, name: string): Promise<string> => {
    const data = await rasterize(entrySvg(image, await load(image), entry));
    const result = await invoke<{ attachment: Attachment }>('agente_media_import', { name, data });
    if (!result.attachment) throw new Error(`Could not attach ${name}.`);
    media.push({ attachment: result.attachment, dataUrl: `data:${result.attachment.mime};base64,${data}` });
    return result.attachment.path;
  };

  for (const [index, entry] of plan.overview.entries()) {
    const image = doc.images.find((item) => item.id === entry.imageId)!;
    if (image.path) hasBitmap = true;
    overviewPaths.push(await importEntry(image, entry, `canvas-${index + 1}-${image.name || 'image.png'}`));
  }
  for (const [index, entry] of plan.points.entries()) {
    const image = doc.images.find((item) => item.id === entry.imageId)!;
    const mark = entry.marks[0]!;
    const path = await importEntry(image, entry, `canvas-point-${index + 1}.png`);
    points.push({ label: mark.text || mark.kind, kind: mark.kind, box: asFractions(entry.box!, image), path });
  }

  const sources = [...new Set(doc.images.map(image => image.sourceUrl).filter(Boolean))];
  const notes = [doc.instructions?.trim(), ...sources.map(url => `Source page: ${url}`)].filter(Boolean).join('\n\n');
  return { media, prompt: [notes, composePrompt(overviewPaths, points, hasBitmap ? header : boardHeader, empty).text].filter(Boolean).join('\n\n') };
}

/** The daemon's filesystem attachment as Home's browser-side one. */
function toChatAttachment(media: ExportedMedia): ChatAttachment {
  const { attachment, dataUrl } = media;
  return {
    id: createId('attachment'),
    name: attachment.name,
    size: attachment.bytes,
    type: attachment.mime,
    base64: dataUrl,
    preview: dataUrl,
    kind: attachment.kind === 'image' ? 'image' : 'document',
    status: 'ready'
  };
}

/**
 * Put the rendered board in front of the user, ready to send.
 *
 * The Code composer holds its own copy so it can stay responsive while a turn
 * runs, so it takes the payload through the event its starter prompts already
 * use. Home's reads its draft straight from the store, but its attachments are
 * a different type, so each composer is given what it expects.
 */
export function handOffToAgent(text: string, media: ExportedMedia[], chatId?: string): boolean {
  const chat = chatId ? appStore.chats.find((item) => item.id === chatId) : appStore.currentChat;
  if (!chat || !chat.codeAgent && appStore.currentChat?.id !== chat.id) return false;
  if (chat.codeAgent) {
    window.dispatchEvent(new CustomEvent('code-composer-append', { detail: { chatId: chat.id, text, media: media.map((item) => item.attachment) } }));
  } else {
    appStore.updateComposer(mergeDraft(appStore.composer, text));
    const next = media.map(toChatAttachment).filter((item) => !appStore.pendingAttachments.some((existing) => existing.name === item.name));
    appStore.pendingAttachments = [...appStore.pendingAttachments, ...next];
  }
  window.dispatchEvent(new Event('focus-composer'));
  return true;
}

/** The panel's send action: render, import, place, and report what happened. */
export async function sendCanvasToAgent(header: string, boardHeader: string, empty: string, sent: string, canvasBoard: CanvasBoardStore = defaultBoard): Promise<void> {
  const chatId = canvasBoard.activeChatId;
  try {
    const { media, prompt } = await exportBoard(header, boardHeader, empty, canvasBoard);
    if (!media.length) {
      toastStore.error(empty);
      return;
    }
    if (!handOffToAgent(prompt, media, chatId)) {
      toastStore.error(empty);
      return;
    }
    toastStore.success(sent);
  } catch (error) {
    toastStore.error(error instanceof Error ? error.message : String(error));
  }
}
