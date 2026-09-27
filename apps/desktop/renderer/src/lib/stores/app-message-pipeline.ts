import type { AppConfig, ChatMessage } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';
import {
  attributeRoleplayContent,
  getMessageRequestContent,
  getMessageRequestReasoning,
  type RoleplayAttribution
} from '$lib/stores/app-store-helpers';

export type { RoleplayAttribution };

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
  attribution?: RoleplayAttribution;
}): RequestMessage[] {
  const outbound: RequestMessage[] = [];

  for (const message of params.messages) {
    if (message.id === params.assistantMessageId) continue;

    if (message.id === params.userMessageId) {
      const content = params.buildContextualPrompt(params.userContent).trim();
      if (!content) continue;
      outbound.push({
        role: 'user',
        content: attributeRoleplayContent('user', null, content, params.attribution)
      });
      continue;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = getMessageRequestContent(message).trim();
    if (!content) continue;
    const reasoning = getMessageRequestReasoning(message);
    outbound.push({
      role,
      content: attributeRoleplayContent(role, message.speakerId, content, params.attribution),
      ...(reasoning ? { reasoning_content: reasoning } : {})
    });
  }

  return outbound;
}

/** Prepend system prompt when present. */
export function prependSystemPrompt(messages: RequestMessage[], systemPrompt: string): RequestMessage[] {
  return systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
}

/**
 * Group chats end with a nudge naming the character whose turn it is. The
 * system prompt already says it; the nudge is the last thing the model reads
 * before generating, which is what actually holds the turn.
 */
export function appendRoleplayNudge(
  messages: RequestMessage[],
  attribution: RoleplayAttribution | undefined
): RequestMessage[] {
  if (!attribution?.group || !attribution.speakerName) return messages;
  const userName = attribution.userName || 'the user';
  return [
    ...messages,
    {
      role: 'system',
      content: `Now write only ${attribution.speakerName}'s reply. Do not write for ${userName} or the other characters.`
    }
  ];
}

/**
 * A story turn the user did not write: a thrown twist, or the silence of an
 * expired choice.
 *
 * It lands just before the nudge so it is the freshest thing the model reads
 * that is not "who speaks now" — and it stays out of the user's turns, because
 * the user did not say it and it should not read as their dialogue.
 */
export function appendRoleplayStoryTurn(
  messages: RequestMessage[],
  instruction: string | undefined | null
): RequestMessage[] {
  const content = instruction?.trim();
  if (!content) return messages;
  return [...messages, { role: 'system', content }];
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
