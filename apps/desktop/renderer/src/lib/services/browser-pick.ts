import { invoke } from '$lib/services/bridge';
import { handOffToAgent, type ExportedMedia } from '$lib/features/canvas/canvas-handoff';
import type { Attachment } from '$shared/agente-protocol.gen';

export interface PickedElement {
  selector: string;
  tag: string;
  role: string;
  text: string;
  attributes: Record<string, string>;
  outerHTML: string;
  rect: { x: number; y: number; width: number; height: number };
  url: string;
  title: string;
  image?: string;
}

export function pickBrowserElements(scope: string, tabId: string | null, multi = true): Promise<PickedElement[]> {
  return invoke('browser_pick_element', { scope, tabId, multi });
}
export async function cancelBrowserPick(scope: string, tabId: string | null): Promise<void> {
  await invoke('browser_pick_cancel', { scope, tabId });
}

const label = (pick: PickedElement): string => `<${pick.tag}>${pick.text ? ` "${pick.text.slice(0, 60)}"` : ''}`;

/** The text block the agent reads: what was picked and how to address it with the browser tools. */
export function pickContext(picks: PickedElement[]): string {
  let where = '';
  try { const u = new URL(picks[0]!.url); where = u.host + u.pathname; } catch { where = picks[0]!.url; }
  const lines = picks.map((pick) => {
    const attrs = Object.entries(pick.attributes).map(([k, v]) => `${k}="${v}"`).join(' ');
    const size = `${Math.round(pick.rect.width)}x${Math.round(pick.rect.height)}`;
    return `- ${label(pick)} selector: ${pick.selector} (${size}${attrs ? `, ${attrs}` : ''})\n  ref for browser tools: css:${pick.selector}\n  html: ${pick.outerHTML.slice(0, 400)}`;
  });
  return `Selected in the browser (${where}):\n${lines.join('\n')}\n(The browser_click / browser_fill / browser_hover tools accept the "css:..." ref above directly.)`;
}

/** Import each crop like the canvas does and put the block + crops in the chat's composer. */
export async function sendPicksToComposer(picks: PickedElement[], chatId: string): Promise<boolean> {
  const media: ExportedMedia[] = [];
  for (const [index, pick] of picks.entries()) {
    if (!pick.image) continue;
    const { attachment } = await invoke<{ attachment: Attachment }>('agente_media_import', { name: `element-${index + 1}-${pick.tag}.png`, data: pick.image.split(',')[1] });
    if (attachment) media.push({ attachment, dataUrl: pick.image });
  }
  return handOffToAgent(pickContext(picks), media, chatId);
}

export const pickChipLabel = label;
