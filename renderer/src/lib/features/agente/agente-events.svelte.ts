// Fan-out for code_agent_event pushes, keyed by chatId. Ported from the
// dormant chatea-agent events store.

import { listen } from '$lib/services/tauri';
import type { CodeAgentEvent } from './agente-protocol';

type EventHandler = (event: CodeAgentEvent) => void;

let initialized = false;
let unsub: (() => void) | null = null;
const handlers = new Map<string, Set<EventHandler>>();

function handlePushEvent(event: CodeAgentEvent): void {
  const chatId = event.chatId;
  if (!chatId) return;
  const set = handlers.get(chatId);
  if (!set) return;
  for (const handler of set) {
    try {
      handler(event);
    } catch {
      // ignore handler errors
    }
  }
}

export function subscribeToCodeAgentEvents(chatId: string, handler: EventHandler): () => void {
  if (!initialized) {
    initialized = true;
    listen<CodeAgentEvent>('code_agent_event', (event) => {
      handlePushEvent(event);
    }).then((off) => {
      unsub = off;
    });
  }

  let set = handlers.get(chatId);
  if (!set) {
    set = new Set();
    handlers.set(chatId, set);
  }
  set.add(handler);

  return () => {
    set?.delete(handler);
    if (set && set.size === 0) {
      handlers.delete(chatId);
    }
  };
}

export function disposeCodeAgentEventStore(): void {
  handlers.clear();
  if (unsub) {
    unsub();
    unsub = null;
  }
  initialized = false;
}
