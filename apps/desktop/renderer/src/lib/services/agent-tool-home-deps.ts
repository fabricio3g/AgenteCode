/**
 * The app-wired dependencies for the Home document tools. Kept apart from
 * `agent-tool-home.ts` and loaded on first use, so the tools' logic (and its
 * tests) never pulls in the app store, the bridge or the speech stack.
 */
import { appStore } from '$lib/stores/app.svelte';
import { invoke } from '$lib/services/bridge';
import { hasConfiguredVisionModel } from '$lib/services/chat-api';
import { sttTranscribe } from '$lib/services/stt';
import { readArrayBuffer } from '$lib/features/chat/viewers/viewer-source';
import type { HomeAttachment, HomeToolDeps } from './agent-tool-home';

export async function defaultDeps(): Promise<HomeToolDeps> {
  return {
    attachments: (chatId) => {
      const chat = appStore.chats.find((entry) => entry.id === chatId);
      const sent = (chat?.messages ?? []).flatMap((message) => message.attachments ?? []);
      const pending = chatId === appStore.currentChatId ? appStore.pendingAttachments : [];
      const seen = new Set<string>();
      return [...sent, ...pending].filter((a) => !seen.has(a.id) && seen.add(a.id)) as HomeAttachment[];
    },
    readWorkspaceBinary: async (root, path) => readArrayBuffer(await invoke<string>('read_workspace_binary', { workspaceRoot: root, relativePath: path }), 'file'),
    dataUrlBytes: (dataUrl) => readArrayBuffer(dataUrl, 'attachment'),
    readIngested: (chatId, docId) => invoke('read_ingested_document', { payload: { chat_id: chatId, doc_id: docId } }),
    visionAvailable: async () => hasConfiguredVisionModel(appStore.config),
    ocr: async (name, type, bytes) => (await import('$lib/services/ocr')).extractTextFromFile(new File([bytes], name, { type })),
    transcribe: async (bytes, mime) => sttTranscribe(new Uint8Array(bytes), mime).then((r) => r.text)
  };
}
