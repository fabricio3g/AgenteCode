import type { ChatContextMode, ChatFolder, ChatSession, ModelOption } from '$lib/types/chat';

export interface PersistedState {
  chats: ChatSession[];
  folders: ChatFolder[];
  currentChatId: string | null;
  activeSpace?: ChatContextMode;
  currentChatIdBySpace?: Partial<Record<ChatContextMode, string | null>>;
}

export type GenerationBackendMode = 'api' | 'local';
export type GenerationComposerMode = 'chat' | 'agent';

export interface ActiveGenerationRun {
  controller: AbortController;
  messageId: string;
  backendMode: GenerationBackendMode;
  mode: GenerationComposerMode;
  startedAt: number;
  researchTaskId?: string | null;
}

export interface ChatSearchState {
  results: import('$lib/types/bridge').SearchResult[];
  loading: boolean;
  query: string;
}

/**
 * A local model the user asked to load: a full model option without the
 * `'local' | 'api'` discriminant (the load dialog only handles local files).
 */
export type LocalModelLoadTarget = Omit<ModelOption, 'source'> & { source?: string };
