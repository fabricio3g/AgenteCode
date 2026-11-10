import type { ChatContextMode, ChatFolder, ChatSession, ModelOption } from '$lib/types/chat';
import type { HomeLiveState } from '$lib/features/home/home-live';

export interface PersistedState {
  chats: ChatSession[];
  folders: ChatFolder[];
  currentChatId: string | null;
  activeSpace?: ChatContextMode;
  currentChatIdBySpace?: Partial<Record<ChatContextMode, string | null>>;
  /** The Bots tab was open. */
}

export type GenerationBackendMode = 'api' | 'local';
export type GenerationComposerMode = 'chat' | 'instant' | 'agent';

export interface ActiveGenerationRun {
  controller: AbortController;
  messageId: string;
  backendMode: GenerationBackendMode;
  mode: GenerationComposerMode;
  startedAt: number;
  /**
   * When this run last said anything (a delta, a step, a progress note).
   *
   * The only clock the UI has for telling work from silence on the Home path:
   * the jump button wears the tile meter off it, exactly as the Code space does
   * off `CodeRunState.lastEventAt`.
   */
  lastEventAt?: number;
  live?: HomeLiveState;
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
