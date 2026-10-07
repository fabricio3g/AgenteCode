import type { AgentArtifact, ChatMessage, ChatSession } from '$lib/types/chat';
import { normalizeArtifact } from '$lib/services/artifact-model';

/**
 * Store every artifact a turn produced, plus the last one under the legacy
 * `artifact` field. Both are written because a lot of the app — the studio,
 * `currentArtifact`, `findLatestArtifactMessage` — still reasons about "the"
 * artifact, and chats saved before this change only have the singular field.
 */
export function applyArtifactsToMessage(
  chat: ChatSession | null,
  messageId: string | null,
  artifacts: AgentArtifact[]
): boolean {
  if (!chat || !messageId) return false;
  const index = chat.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return false;
  const normalized = artifacts.map((artifact) => normalizeArtifact(artifact));
  chat.messages[index] = {
    ...chat.messages[index],
    artifacts: normalized,
    artifact: normalized.length ? normalized[normalized.length - 1] : null
  };
  return true;
}

/**
 * Update one artifact in place, leaving the rest of the turn's artifacts alone.
 *
 * Used when the studio saves an edit, or when the selected artifact is written back.
 * A whole-list replace would be wrong there: editing the chart in a turn that also
 * produced a diagram would delete the diagram. Entries are matched on
 * `manifest.entryPath`, which the tool dispatcher derives from the tool's first
 * created file. Passing `null` clears the turn's artifacts.
 */
export function upsertArtifactOnMessage(
  chat: ChatSession | null,
  messageId: string | null,
  artifact: AgentArtifact | null
): boolean {
  if (!chat || !messageId) return false;
  const index = chat.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return false;
  if (!artifact) return applyArtifactsToMessage(chat, messageId, []);

  const existing = artifactsForMessage(chat.messages[index]);
  const normalized = normalizeArtifact(artifact);
  const key = normalized.manifest?.entryPath;
  const at = key ? existing.findIndex((entry) => entry.manifest?.entryPath === key) : -1;
  const next = at >= 0
    ? existing.map((entry, position) => (position === at ? normalized : entry))
    : [...existing, normalized];
  return applyArtifactsToMessage(chat, messageId, next);
}

/**
 * Delete one artifact from a turn, by its position in `artifactsForMessage`.
 * The others on the same message stay (and the legacy `artifact` field follows
 * the new last one). Artifact content lives inline on the message, so nothing
 * is left behind on disk.
 */
export function removeArtifactFromMessage(
  chat: ChatSession | null,
  messageId: string | null,
  index: number
): boolean {
  if (!chat || !messageId) return false;
  const message = chat.messages.find((entry) => entry.id === messageId);
  const existing = artifactsForMessage(message);
  if (index < 0 || index >= existing.length) return false;
  return applyArtifactsToMessage(chat, messageId, existing.filter((_, position) => position !== index));
}

/**
 * Every artifact on a message, oldest first. Messages persisted before artifacts
 * became a list carry only the singular field, so it is promoted to a one-item list.
 */
export function artifactsForMessage(message: ChatMessage | null | undefined): AgentArtifact[] {
  if (!message) return [];
  if (message.artifacts?.length) return message.artifacts;
  return message.artifact ? [message.artifact] : [];
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
