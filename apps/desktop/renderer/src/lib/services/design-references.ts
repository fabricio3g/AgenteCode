/**
 * Images a design message carries become `references/` files, so the agent
 * can look at what the user sent before it designs. The bytes go to main, which
 * checks them and the workspace limits; nothing here decides what is an image
 * beyond the attachment's own type.
 */
import type { RequestMessage } from './chat-api';
import { invoke } from './bridge';
import type { DesignReferenceAdded } from '$shared/design';

const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,/i;

/** The image attachments of one message, as the file name and base64 payload main needs. */
export function referenceImages(message: RequestMessage | undefined): Array<{ name: string; data: string }> {
  return (message?.attachments ?? []).flatMap((attachment) => {
    const prefix = attachment.base64?.match(DATA_IMAGE)?.[0];
    if (attachment.kind !== 'image' || !prefix || !attachment.base64) return [];
    return [{ name: attachment.name || 'image', data: attachment.base64.slice(prefix.length) }];
  });
}

/**
 * Copy the images of this turn's message into the chat's `references/` folder.
 * Returns the workspace paths; an image main refuses is skipped, not fatal.
 */
export async function saveReferenceImages(chatId: string, messages: RequestMessage[]): Promise<string[]> {
  const latest = [...messages].reverse().find((message) => message.role === 'user');
  const saved: string[] = [];
  for (const image of referenceImages(latest)) {
    try {
      const added = await invoke<DesignReferenceAdded>('design_manage', { chatId, action: 'add_reference', name: image.name, data: image.data });
      saved.push(added.path);
    } catch {
      // Unreadable or oversized: the message still carries the picture to a vision model.
    }
  }
  return saved;
}
