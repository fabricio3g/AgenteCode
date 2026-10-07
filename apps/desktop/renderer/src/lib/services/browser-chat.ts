// ── Browser chat (the extension's side panel, answered here) ──────────
// Main relays each request from the extension (main/agente/browser-chat.ts);
// this module answers it with the app's own Home machinery, so a browser
// conversation is an ordinary Home chat — same agent, tools and storage —
// marked `origin: 'browser'` for its own sidebar section.
//
// The reply is followed by watching the chat's last assistant message rather
// than by threading callbacks through sendCurrentMessage: what the panel shows
// is exactly what this window shows.

import { invoke, listen } from '$lib/services/bridge';
import { appStore } from '$lib/stores/app.svelte';
import { createId } from '$lib/utils/id';
import type { ChatMessage, ChatSession } from '$lib/types/chat';
import {
  withoutPageContext,
  withPageContext,
  type BrowserChatMessage,
  type ChatEvent,
  type ChatRequest
} from '$shared/browser/chat-protocol';

/** How often a running reply is re-read for the panel. */
const FOLLOW_MS = 120;
/** A follow that outlives this is abandoned (the chat itself keeps going). */
const FOLLOW_LIMIT_MS = 30 * 60_000;

const reply = (id: string, body: ChatEvent) => invoke('browser_chat_reply', { id, body }).catch(() => {});

const isBrowserChat = (chat: ChatSession | null | undefined): chat is ChatSession => chat?.origin === 'browser';

function lastAssistant(chat: ChatSession): ChatMessage | undefined {
  for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].role === 'assistant') return chat.messages[i];
}

function transcript(chat: ChatSession): BrowserChatMessage[] {
  return chat.messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && (message.content || '').trim())
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      text: message.role === 'user' ? withoutPageContext(message.content) : message.content
    }));
}

/** The page a conversation began on, from its first message's preamble. */
function startUrl(chat: ChatSession): string | undefined {
  const first = chat.messages.find((message) => message.role === 'user')?.content ?? '';
  return /^\[Browser tab: .* — (\S+)\]/.exec(first)?.[1];
}

/**
 * Stream one reply to the panel: the text so far, each step as it changes,
 * then `done` (or the error). Returns a stop for a turn that never began.
 */
function follow(id: string, chatId: string, before: number): () => void {
  const started = Date.now();
  let sentText = '';
  const sentSteps = new Map<string, string>();
  const timer = setInterval(() => {
    const chat = appStore.findChat(chatId);
    if (!chat || Date.now() - started > FOLLOW_LIMIT_MS) {
      clearInterval(timer);
      void reply(id, { type: 'done', chatId });
      return;
    }
    const message = chat.messages.length > before ? lastAssistant(chat) : undefined;
    if (!message) return;
    for (const step of message.agentSteps ?? []) {
      if (step.preface || step.type === 'thinking') continue;
      const status = step.status === 'error' ? 'error' : step.status === 'done' ? 'done' : 'running';
      if (sentSteps.get(step.id) === status) continue;
      sentSteps.set(step.id, status);
      void reply(id, { type: 'step', chatId, label: step.label, status });
    }
    const text = message.content || '';
    if (text !== sentText) {
      sentText = text;
      void reply(id, { type: 'text', chatId, text });
    }
    if (message.done && !appStore.isChatGenerating(chatId)) {
      clearInterval(timer);
      void reply(id, message.status === 'error' ? { type: 'error', chatId, message: text || 'The reply failed.' } : { type: 'done', chatId });
    }
  }, FOLLOW_MS);
  return () => clearInterval(timer);
}

async function handle(id: string, request: ChatRequest) {
  switch (request.type) {
    case 'send': {
      const text = request.text?.trim();
      if (!text) return reply(id, { type: 'error', message: 'Empty message.' });
      let chat = request.chatId ? appStore.findChat(request.chatId) : null;
      if (request.chatId && !isBrowserChat(chat)) {
        return reply(id, { type: 'error', message: 'That conversation is gone. Start a new one.' });
      }
      chat ??= appStore.createBrowserChat();
      const chatId = chat.id;
      await reply(id, { type: 'started', chatId, title: chat.title });
      const before = chat.messages.length;
      const stop = follow(id, chatId, before);
      await appStore.sendCurrentMessage({
        chatId,
        queuedPrompt: { id: createId('prompt'), content: withPageContext(text, request.page), attachments: [] }
      });
      // Settled without a message and nothing queued: the app refused to start
      // (no model, no key). Say so instead of leaving the panel waiting.
      const after = appStore.findChat(chatId);
      if (after && after.messages.length === before && !after.pendingPrompts?.length) {
        stop();
        return reply(id, { type: 'error', chatId, message: appStore.error || 'Agente Desktop could not start a reply. Check that a model is set up in Desktop.' });
      }
      return;
    }
    case 'stop':
      if (isBrowserChat(appStore.findChat(request.chatId))) appStore.stopStreaming(request.chatId);
      return reply(id, { type: 'ok' });
    case 'list':
      return reply(id, {
        type: 'list',
        chats: appStore.chats
          .filter(isBrowserChat)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 50)
          .map((chat) => ({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, url: startUrl(chat) }))
      });
    case 'history': {
      const chat = appStore.findChat(request.chatId);
      if (!isBrowserChat(chat)) return reply(id, { type: 'error', message: 'That conversation is gone.' });
      return reply(id, { type: 'history', chatId: chat.id, title: chat.title, messages: transcript(chat) });
    }
    case 'reveal':
      if (isBrowserChat(appStore.findChat(request.chatId))) appStore.selectChat(request.chatId);
      return reply(id, { type: 'ok' });
    default:
      return reply(id, { type: 'error', message: 'This version of Agente Desktop does not understand that request. Update the app or the extension.' });
  }
}

/** Start answering the extension. Returns the unsubscribe. */
export async function startBrowserChat(): Promise<() => void> {
  const off = await listen<{ id: string; body: ChatRequest }>('browser_chat_request', ({ id, body }) => {
    void handle(id, body).catch((error) => reply(id, { type: 'error', message: String(error?.message ?? error) }));
  });
  // Main holds requests back until this window can answer them.
  await invoke('browser_chat_ready').catch(() => {});
  return off;
}
