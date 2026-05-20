export type RoleplaySourceFormat = 'tavern-v2-json' | 'tavern-v1-json' | 'tavern-png' | 'unknown-json';

export interface RoleplayLorebookEntry {
  id: string;
  keys: string[];
  secondaryKeys?: string[];
  content: string;
  comment?: string;
  enabled: boolean;
  insertionOrder?: number;
  constant?: boolean;
  sourceCharacterId?: string | null;
}

export interface RoleplayLorebook {
  id: string;
  name: string;
  entries: RoleplayLorebookEntry[];
  createdAt: number;
  updatedAt: number;
  sourceCharacterId?: string | null;
}

export interface RoleplayCharacter {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue: string;
  creatorNotes: string;
  tags: string[];
  avatarDataUrl?: string;
  attachedLorebookIds?: string[];
  sourceFormat: RoleplaySourceFormat;
  rawPayload?: unknown;
  embeddedLorebook?: RoleplayLorebook | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoleplaySelfProfile {
  name: string;
  description: string;
  avatarDataUrl?: string;
  tags?: string[];
  notes?: string;
}

export interface RoleplayMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  speaker?: string;
  model?: string;
  status?: 'idle' | 'streaming' | 'error';
  reasoning?: string;
}

export type RoleplayConversationMode = 'oneToOne' | 'group' | 'narrative';

export interface RoleplaySettings {
  responseLength: 'brief' | 'balanced' | 'long';
  narrationStyle: 'immersive' | 'dialogue-heavy' | 'concise';
  maxSpeakerTurns: number;
  allowMultipleCharacters: boolean;
  allowNarrator: boolean;
  userName: string;
  sceneContext: string;
  conversationMode: RoleplayConversationMode;
  primaryCharacterId?: string | null;
  sceneSetupComplete: boolean;
}

export interface RoleplayChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  draft: string;
  messages: RoleplayMessage[];
  activeCharacterIds: string[];
  lorebookIds: string[];
  settings: RoleplaySettings;
  summary?: string;
}

export interface RoleplayPersistedState {
  chats: RoleplayChat[];
  characters: RoleplayCharacter[];
  lorebooks: RoleplayLorebook[];
  selfProfile: RoleplaySelfProfile;
  currentChatId: string | null;
}
