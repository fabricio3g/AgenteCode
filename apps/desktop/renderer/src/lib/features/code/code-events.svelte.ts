// Fan-out for code_agent_event pushes, keyed by chatId. Ported from the
// dormant chatea-agent events store.

import { listen } from '$lib/services/bridge';
import type { CodeAgentEvent } from '$shared/agente-protocol';

type EventHandler = (event: CodeAgentEvent) => void;

/** Subscribe to every chat's events (the store's own fan-out). */
const WILDCARD = '*';

let initialized = false;
const handlers = new Map<string, Set<EventHandler>>();

function handlePushEvent(event: CodeAgentEvent): void {
  const chatId = event.chatId;
  if (!chatId) return;
  for (const handler of handlers.get(chatId) ?? []) {
    try {
      handler(event);
    } catch {
      // ignore handler errors
    }
  }
  for (const handler of handlers.get(WILDCARD) ?? []) {
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
    void listen<CodeAgentEvent>('code_agent_event', (event) => {
      handlePushEvent(event);
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
