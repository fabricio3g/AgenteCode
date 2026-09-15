import type { AppConfig, ChatMessage } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';
import { getMessageRequestContent, getMessageRequestReasoning } from '$lib/stores/app-store-helpers';

/**
 * Build clean LLM request messages from the chat transcript.
 * - Uses active version content for assistants (not empty shell content)
 * - Patches only the current user turn with contextual prompt extras
 * - Returns pure { role, content } rows (no ChatMessage bags)
 */
export function buildRequestMessagesWithPatchedUser(params: {
  messages: ChatMessage[];
  assistantMessageId: string;
  userMessageId: string;
  userContent: string;
  buildContextualPrompt: (content: string) => string;
}): RequestMessage[] {
  const outbound: RequestMessage[] = [];

  for (const message of params.messages) {
    if (message.id === params.assistantMessageId) continue;

    if (message.id === params.userMessageId) {
      const content = params.buildContextualPrompt(params.userContent).trim();
      if (!content) continue;
      outbound.push({ role: 'user', content });
      continue;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = getMessageRequestContent(message).trim();
    if (!content) continue;
    const reasoning = getMessageRequestReasoning(message);
    outbound.push({ role, content, ...(reasoning ? { reasoning_content: reasoning } : {}) });
  }

  return outbound;
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
  isElectron: boolean;
  config: AppConfig;
  messages: RequestMessage[];
  invoke: <T = unknown>(channel: string, payload?: unknown) => Promise<T>;
  onTruncated?: (removedCount: number) => void;
  /** When true (uploads / RAG docs), do not truncate — preserve document context. */
  preserveDocuments?: boolean;
}): Promise<void> {
  if (params.backendMode !== 'local' || !params.isElectron) return;
  if (params.preserveDocuments) return;

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
