import type { AppConfig, ChatMessage } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';

/** Clone chat messages for a request and patch only the active user message content. */
export function buildRequestMessagesWithPatchedUser(params: {
  messages: ChatMessage[];
  assistantMessageId: string;
  userMessageId: string;
  userContent: string;
  buildContextualPrompt: (content: string) => string;
}): RequestMessage[] {
  return params.messages
    .filter((message) => message.id !== params.assistantMessageId)
    .map((message) => {
      if (message.id !== params.userMessageId) return message;
      return {
        ...message,
        content: params.buildContextualPrompt(params.userContent)
      };
    });
}

/** Prepend system prompt when present. */
export function prependSystemPrompt(messages: RequestMessage[], systemPrompt: string): RequestMessage[] {
  return systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
}

/** Build outbound request messages with optional system preface. */
export function buildOutboundMessages(params: {
  messages: RequestMessage[];
  systemPrompt: string;
}): RequestMessage[] {
  return prependSystemPrompt(params.messages, params.systemPrompt);
}

/** Apply local context truncation in-place when message budget overflows. */
export async function applyLocalContextBudgetTruncation(params: {
  backendMode: 'api' | 'local';
  isTauri: boolean;
  config: AppConfig;
  messages: RequestMessage[];
  invoke: <T = unknown>(channel: string, payload?: unknown) => Promise<T>;
  onTruncated?: (removedCount: number) => void;
}): Promise<void> {
  if (params.backendMode !== 'local' || !params.isTauri) return;

  const budget = await params.invoke<{ isOverflow?: boolean }>('build_context_budget', {
    config: {
      context_length: params.config.llm?.local?.context_length || 4096,
      max_tokens: params.config.llm?.local?.max_tokens
    },
    messages: params.messages
  });

  if (!budget?.isOverflow) return;
  const truncated = await params.invoke<RequestMessage[]>('truncate_messages', {
    messages: params.messages,
    budget
  });

  if (!Array.isArray(truncated) || truncated.length >= params.messages.length) return;
  const removed = params.messages.length - truncated.length;
  params.messages.splice(0, params.messages.length, ...truncated);
  params.onTruncated?.(removed);
}
