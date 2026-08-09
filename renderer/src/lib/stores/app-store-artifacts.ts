import type { AgentArtifact, ChatMessage, ChatSession } from '$lib/types/chat';
import { normalizeArtifact } from '$lib/services/artifact-model';

export function applyArtifactToMessage(
  chat: ChatSession | null,
  messageId: string | null,
  artifact: AgentArtifact | null
): boolean {
  if (!chat || !messageId) return false;
  const index = chat.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return false;
  chat.messages[index] = {
    ...chat.messages[index],
    artifact: artifact ? normalizeArtifact(artifact) : null
  };
  return true;
}

export function resolveArtifactForMessage(
  chat: ChatSession | null,
  messageId: string | null
): AgentArtifact | null {
  if (!chat || !messageId) return null;
  return chat.messages.find((message) => message.id === messageId)?.artifact || null;
}

export function findLatestArtifactMessage(chat: ChatSession | null): ChatMessage | null {
  if (!chat) return null;
  return [...chat.messages].reverse().find((message) => message.artifact) || null;
}
