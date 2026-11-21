/**
 * The app-wired dependencies for the Home document tools. Kept apart from
 * `agent-tool-home.ts` and bound from the composition root (`app.svelte.ts`),
 * so neither module forms a dependency cycle with the app store.
 */
import type { AppConfig, Attachment, ChatSession } from '$lib/types/chat';
import { invoke } from '$lib/services/bridge';
import { hasConfiguredVisionModel } from '$lib/services/chat-api';
import { sttTranscribe } from '$lib/services/stt';
import { readArrayBuffer } from '$lib/features/chat/viewers/viewer-source';
import type { HomeAttachment, HomeToolDeps } from './agent-tool-home';

export interface HomeToolStoreSource {
  getChats: () => ChatSession[];
  getCurrentChatId: () => string | null;
  getPendingAttachments: () => Attachment[];
  getConfig: () => AppConfig;
}

export function createHomeToolDeps(source: HomeToolStoreSource): () => Promise<HomeToolDeps> {
  return async () => ({
    attachments: (chatId) => {
      const chat = source.getChats().find((entry) => entry.id === chatId);
      const sent = (chat?.messages ?? []).flatMap((message) => message.attachments ?? []);
      const pending = chatId === source.getCurrentChatId() ? source.getPendingAttachments() : [];
      const seen = new Set<string>();
      return [...sent, ...pending].filter((a) => !seen.has(a.id) && seen.add(a.id)) as HomeAttachment[];
    },
    readWorkspaceBinary: async (root, path) => readArrayBuffer(await invoke<string>('read_workspace_binary', { workspaceRoot: root, relativePath: path }), 'file'),
    dataUrlBytes: (dataUrl) => readArrayBuffer(dataUrl, 'attachment'),
    readIngested: (chatId, docId) => invoke('read_ingested_document', { payload: { chat_id: chatId, doc_id: docId } }),
    visionAvailable: async () => hasConfiguredVisionModel(source.getConfig()),
    ocr: async (name, type, bytes) => (await import('$lib/services/ocr')).extractTextFromFile(new File([bytes], name, { type })),
    transcribe: async (bytes, mime) => sttTranscribe(new Uint8Array(bytes), mime).then((r) => r.text)
  });
}
