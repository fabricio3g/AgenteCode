/** Construct request messages without changing stored conversation history. */
import { isVisionModel } from '$shared/model-capabilities';
import type { ContentPart, RequestMessage } from './types';

const MAX_REQUEST_IMAGES = 20;

export function toRequestMessages(messages: RequestMessage[], modelName?: string, hasMmproj?: boolean) {
  const visionCapable = hasMmproj !== undefined ? hasMmproj : isVisionModel(modelName || '');

  // Count images from newest to oldest so we keep the newest MAX_REQUEST_IMAGES
  let imagesAllowed = MAX_REQUEST_IMAGES;
  const allowedImageKeys = new Set<string>();
  if (visionCapable) {
    for (let m = messages.length - 1; m >= 0; m--) {
      const msg = messages[m];
      if (msg.role === 'user' && msg.attachments) {
        for (let a = msg.attachments.length - 1; a >= 0; a--) {
          const att = msg.attachments[a];
          if (att.kind === 'image' && att.base64 && String(att.base64).startsWith('data:')) {
            if (imagesAllowed > 0) {
              allowedImageKeys.add(`${m}:${a}`);
              imagesAllowed--;
            }
          }
        }
      }
    }
  }

  return messages.map((message, mIndex) => {
    const base: Record<string, unknown> = { role: message.role };

    const activeImageAttachments: Array<{ kind?: string; base64?: string; name?: string; ocrText?: string }> = [];
    const omittedImageNotes: string[] = [];

    const rawAttachments = message.attachments || [];
    for (let aIndex = 0; aIndex < rawAttachments.length; aIndex++) {
      const a = rawAttachments[aIndex];
      if (a.kind === 'image' && a.base64 && String(a.base64).startsWith('data:')) {
        if (visionCapable) {
          if (allowedImageKeys.has(`${mIndex}:${aIndex}`)) {
            activeImageAttachments.push(a);
          } else {
            omittedImageNotes.push(`[Image: ${a.name || 'image'} (omitted from earlier history to stay under provider image limit)]`);
          }
        }
      }
    }

    const ocrTexts: string[] = [];
    for (const att of rawAttachments) {
      if (att.ocrText) ocrTexts.push(`[${att.name}]: ${att.ocrText}`);
    }
    const ocrContext = [
      ...ocrTexts,
      ...omittedImageNotes
    ].length ? '\n\n--- Attached file contents ---\n' + [...ocrTexts, ...omittedImageNotes].join('\n\n') : '';

    if (message.role === 'user' && activeImageAttachments.length && visionCapable) {
      const parts: ContentPart[] = [];
      const textContent = (message.content || '') + ocrContext;
      if (textContent) parts.push({ type: 'text', text: String(textContent) });
      for (const img of activeImageAttachments) {
        parts.push({ type: 'image_url', image_url: { url: img.base64!, detail: 'auto' } });
      }
      base.content = parts;
    } else {
      base.content = Array.isArray(message.content)
        ? [...message.content, ...(ocrContext ? [{ type: 'text' as const, text: ocrContext }] : [])]
        : (message.content || '') + ocrContext;
    }

    if (message.tool_calls) base.tool_calls = message.tool_calls;
    if (message.tool_call_id) base.tool_call_id = message.tool_call_id;
    if (message.name) base.name = message.name;
    if (message.reasoning_content != null) base.reasoning_content = message.reasoning_content;
    if (message.providerState) base.providerState = message.providerState;
    return base;
  });
}

