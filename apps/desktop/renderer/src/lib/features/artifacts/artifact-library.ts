// Every artifact across the user's chats, flattened for the Artifacts screen.

import type { AgentArtifact, ArtifactKind, ChatSession } from '$lib/types/chat';
import { artifactsForMessage } from '$lib/stores/app-store-artifacts';
import { resolveArtifactPresentation } from '$lib/services/artifact-model';

export type ArtifactGroup = 'documents' | 'presentations' | 'spreadsheets' | 'visuals' | 'learning' | 'web';

export interface LibraryEntry {
  key: string;
  chatId: string;
  chatTitle: string;
  messageId: string;
  /** Position among the message's artifacts. */
  index: number;
  artifact: AgentArtifact;
  kind: ArtifactKind;
  group: ArtifactGroup;
  createdAt: number;
}

const GROUP_OF: Partial<Record<ArtifactKind, ArtifactGroup>> = {
  report: 'documents',
  work_product: 'documents',
  document: 'documents',
  pdf: 'documents',
  research_package: 'documents',
  presentation: 'presentations',
  spreadsheet: 'spreadsheets',
  chart: 'visuals',
  diagram: 'visuals',
  map: 'visuals',
  dashboard: 'visuals',
  info_card: 'visuals',
  lesson: 'learning',
  html_card: 'web',
  web: 'web',
  files: 'web'
};

export function groupOf(kind: ArtifactKind): ArtifactGroup {
  return GROUP_OF[kind] ?? 'web';
}

/** Newest first. Code-space chats never produce artifacts and are skipped. */
export function collectArtifacts(chats: readonly ChatSession[]): LibraryEntry[] {
  const entries: LibraryEntry[] = [];
  for (const chat of chats) {
    if (chat.contextMode === 'code') continue;
    for (const message of chat.messages ?? []) {
      artifactsForMessage(message).forEach((artifact, index) => {
        const kind = resolveArtifactPresentation(artifact).manifest.kind;
        entries.push({
          key: `${chat.id}:${message.id}:${index}`,
          chatId: chat.id,
          chatTitle: chat.title,
          messageId: message.id,
          index,
          artifact,
          kind,
          group: groupOf(kind),
          createdAt: message.createdAt || chat.updatedAt || 0
        });
      });
    }
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

/** Search over title, kind and the chat it came from. */
export function filterArtifacts(entries: readonly LibraryEntry[], query: string, group: ArtifactGroup | 'all'): LibraryEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) =>
    (group === 'all' || entry.group === group)
    && (!needle || `${entry.artifact.title} ${entry.kind} ${entry.chatTitle}`.toLowerCase().includes(needle))
  );
}
