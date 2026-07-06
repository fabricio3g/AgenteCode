import type { ChatContextMode, ChatFolder, ChatSession, CodeProject } from '$lib/types/chat';

export interface PersistedState {
  chats: ChatSession[];
  folders: ChatFolder[];
  codeProjects?: CodeProject[];
  currentChatId: string | null;
  activeSpace?: ChatContextMode;
  currentChatIdBySpace?: Partial<Record<ChatContextMode, string | null>>;
  currentProjectId?: string | null;
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
  results: import('$lib/types/tauri').SearchResult[];
  loading: boolean;
  query: string;
}

export interface LocalModelLoadTarget {
  id: string;
  name: string;
  path?: string;
  details?: string;
  context_length?: number;
}
