import { streamAssistantReply, type CompletionResult } from '$lib/services/chat-api';
import { createBlankRoleplayCharacter, parseRoleplayCardJson, parseRoleplayCardPng } from '$lib/services/roleplay-card';
import { buildRoleplayMessages } from '$lib/services/roleplay-prompt';
import { appStore } from '$lib/stores/app.svelte';
import type { RoleplayCharacter, RoleplayChat, RoleplayLorebook, RoleplayMessage, RoleplayPersistedState, RoleplaySelfProfile, RoleplaySettings } from '$lib/types/roleplay';
import { loadRoleplayState, loadRoleplayStateFromDb, saveRoleplayState, saveRoleplayStateToDb } from '$lib/utils/storage';
import { toErrorMessage } from '$lib/utils/errors';

const DEFAULT_STATE: RoleplayPersistedState = {
  chats: [],
  characters: [],
  lorebooks: [],
  selfProfile: { name: 'User', description: '' },
  currentChatId: null
};

function createId(prefix: string) {
  if (crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function defaultSettings(): RoleplaySettings {
  return {
    responseLength: 'balanced',
    narrationStyle: 'immersive',
    maxSpeakerTurns: 2,
    allowMultipleCharacters: true,
    allowNarrator: true,
    userName: 'User',
    sceneContext: '',
    conversationMode: 'oneToOne',
    primaryCharacterId: null,
    sceneSetupComplete: false
  };
}

function normalizeSettings(value: Partial<RoleplaySettings> | undefined): RoleplaySettings {
  const rawMode = String(value?.conversationMode || 'oneToOne');
  const conversationMode = rawMode === 'group' || rawMode === 'oneToOne'
    ? rawMode
    : 'narrative';
  return {
    ...defaultSettings(),
    ...(value || {}),
    maxSpeakerTurns: Math.max(1, Math.min(8, Number(value?.maxSpeakerTurns || 2))),
    allowMultipleCharacters: conversationMode !== 'oneToOne',
    sceneContext: String(value?.sceneContext || ''),
    conversationMode,
    primaryCharacterId: value?.primaryCharacterId ? String(value.primaryCharacterId) : null,
    sceneSetupComplete: Boolean(value?.sceneSetupComplete)
  };
}

function normalizeCharacter(character: RoleplayCharacter): RoleplayCharacter {
  return {
    ...character,
    attachedLorebookIds: Array.isArray(character.attachedLorebookIds)
      ? character.attachedLorebookIds.map(String)
      : []
  };
}

function normalizeChat(chat: Partial<RoleplayChat>, index: number): RoleplayChat {
  const now = Date.now();
  const activeCharacterIds = Array.isArray(chat.activeCharacterIds) ? chat.activeCharacterIds.map(String) : [];
  const settings = normalizeSettings(chat.settings);
  settings.primaryCharacterId = activeCharacterIds.includes(settings.primaryCharacterId || '')
    ? settings.primaryCharacterId
    : activeCharacterIds[0] || null;
  return {
    id: String(chat.id || createId(`rp-chat-${index}`)),
    title: String(chat.title || 'New roleplay'),
    createdAt: Number.isFinite(chat.createdAt) ? Number(chat.createdAt) : now,
    updatedAt: Number.isFinite(chat.updatedAt) ? Number(chat.updatedAt) : now,
    draft: String(chat.draft || ''),
    messages: Array.isArray(chat.messages) ? chat.messages.map((message, messageIndex) => ({
      id: String(message.id || createId(`rp-msg-${messageIndex}`)),
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content || ''),
      createdAt: Number.isFinite(message.createdAt) ? Number(message.createdAt) : now,
      speaker: message.speaker,
      model: message.model,
      status: message.status || 'idle',
      reasoning: message.reasoning
    })) : [],
    activeCharacterIds,
    lorebookIds: Array.isArray(chat.lorebookIds) ? chat.lorebookIds.map(String) : [],
    settings,
    summary: chat.summary
  };
}

function normalizeState(state: Partial<RoleplayPersistedState> | null | undefined): RoleplayPersistedState {
  const chats = Array.isArray(state?.chats) ? state!.chats.map(normalizeChat) : [];
  const selfProfile: RoleplaySelfProfile = {
    name: String(state?.selfProfile?.name || 'User'),
    description: String(state?.selfProfile?.description || ''),
    avatarDataUrl: state?.selfProfile?.avatarDataUrl ? String(state.selfProfile.avatarDataUrl) : undefined,
    tags: Array.isArray(state?.selfProfile?.tags) ? state!.selfProfile!.tags.map(String) : [],
    notes: state?.selfProfile?.notes ? String(state.selfProfile.notes) : ''
  };
  return {
    chats,
    characters: Array.isArray(state?.characters) ? state!.characters.map(normalizeCharacter) : [],
    lorebooks: Array.isArray(state?.lorebooks) ? state!.lorebooks : [],
    selfProfile,
    currentChatId: state?.currentChatId && chats.some((chat) => chat.id === state.currentChatId)
      ? state.currentChatId
      : chats[0]?.id || null
  };
}

async function fileToBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read image.'));
    reader.readAsDataURL(blob);
  });
}

class RoleplayStore {
  ready = $state(false);
  chats = $state<RoleplayChat[]>([]);
  characters = $state<RoleplayCharacter[]>([]);
  lorebooks = $state<RoleplayLorebook[]>([]);
  selfProfile = $state<RoleplaySelfProfile>({ name: 'User', description: '' });
  currentChatId = $state<string | null>(null);
  libraryOpen = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  abortController = $state<AbortController | null>(null);

  get currentChat() {
    return this.chats.find((chat) => chat.id === this.currentChatId) || null;
  }

  get currentCast() {
    const ids = new Set(this.currentChat?.activeCharacterIds || []);
    return this.characters.filter((character) => ids.has(character.id));
  }

  get persistedState(): RoleplayPersistedState {
    return {
      chats: this.chats,
      characters: this.characters,
      lorebooks: this.lorebooks,
      selfProfile: this.selfProfile,
      currentChatId: this.currentChatId
    };
  }

  async init() {
    const localState = loadRoleplayState<RoleplayPersistedState>(DEFAULT_STATE);
    const dbState = await loadRoleplayStateFromDb();
    const state = normalizeState(dbState || localState);
    this.chats = state.chats;
    this.characters = state.characters;
    this.lorebooks = state.lorebooks;
    this.selfProfile = state.selfProfile;
    this.currentChatId = state.currentChatId;
    if (!this.chats.length) this.createChat(false);
    this.ready = true;
  }

  persist() {
    const plain = JSON.parse(JSON.stringify(this.persistedState)) as RoleplayPersistedState;
    saveRoleplayState(plain);
    void saveRoleplayStateToDb(plain);
  }

  createChat(persist = true) {
    const now = Date.now();
    const chat: RoleplayChat = {
      id: createId('rp-chat'),
      title: 'New roleplay',
      createdAt: now,
      updatedAt: now,
      draft: '',
      messages: [],
      activeCharacterIds: [],
      lorebookIds: [],
      settings: normalizeSettings({ ...defaultSettings(), userName: this.selfProfile.name || 'User' })
    };
    this.chats = [chat, ...this.chats];
    this.currentChatId = chat.id;
    if (persist) this.persist();
    return chat;
  }

  selectChat(chatId: string) {
    if (!this.chats.some((chat) => chat.id === chatId)) return;
    this.currentChatId = chatId;
    this.persist();
  }

  deleteChat(chatId: string) {
    this.chats = this.chats.filter((chat) => chat.id !== chatId);
    if (this.currentChatId === chatId) this.currentChatId = this.chats[0]?.id || null;
    if (!this.chats.length) this.createChat(false);
    this.persist();
  }

  renameChat(chatId: string, title: string) {
    const chat = this.chats.find((entry) => entry.id === chatId);
    const trimmed = title.trim();
    if (!chat || !trimmed) return;
    chat.title = trimmed;
    chat.updatedAt = Date.now();
    this.persist();
  }

  setDraft(value: string) {
    const chat = this.currentChat;
    if (!chat) return;
    chat.draft = value;
    this.persist();
  }

  updateSettings(partial: Partial<RoleplaySettings>) {
    const chat = this.currentChat;
    if (!chat) return;
    chat.settings = normalizeSettings({ ...chat.settings, ...partial });
    if (chat.settings.primaryCharacterId && !chat.activeCharacterIds.includes(chat.settings.primaryCharacterId)) {
      chat.settings.primaryCharacterId = chat.activeCharacterIds[0] || null;
    }
    if (!chat.settings.primaryCharacterId && chat.activeCharacterIds.length) {
      chat.settings.primaryCharacterId = chat.activeCharacterIds[0];
    }
    chat.updatedAt = Date.now();
    this.persist();
  }

  updateSelfProfile(partial: Partial<RoleplaySelfProfile>) {
    const nextName = String(partial.name ?? this.selfProfile.name ?? 'User').trim() || 'User';
    const nextDescription = String(partial.description ?? this.selfProfile.description ?? '');
    const nextAvatar = partial.avatarDataUrl === undefined ? this.selfProfile.avatarDataUrl : (partial.avatarDataUrl || undefined);
    const nextTags = partial.tags === undefined
      ? (this.selfProfile.tags || [])
      : partial.tags.map((tag) => String(tag).trim()).filter(Boolean);
    const nextNotes = partial.notes === undefined ? (this.selfProfile.notes || '') : String(partial.notes || '');
    this.selfProfile = {
      name: nextName,
      description: nextDescription,
      avatarDataUrl: nextAvatar,
      tags: nextTags,
      notes: nextNotes
    };
    const chat = this.currentChat;
    if (chat) {
      chat.settings = normalizeSettings({ ...chat.settings, userName: nextName });
      chat.updatedAt = Date.now();
    }
    this.persist();
  }

  resetSelfProfile() {
    this.selfProfile = { name: 'User', description: '', tags: [], notes: '' };
    const chat = this.currentChat;
    if (chat) {
      chat.settings = normalizeSettings({ ...chat.settings, userName: 'User' });
      chat.updatedAt = Date.now();
    }
    this.persist();
  }

  applySelfToCurrentChat(options?: { autoLoadCast?: boolean; characterId?: string }) {
    const chat = this.currentChat;
    if (!chat) return;
    chat.settings = normalizeSettings({ ...chat.settings, userName: this.selfProfile.name || 'User' });
    if (options?.autoLoadCast) {
      const id = options.characterId || this.characters.find((character) => character.name === this.selfProfile.name)?.id;
      if (id && this.characters.some((character) => character.id === id) && !chat.activeCharacterIds.includes(id)) {
        chat.activeCharacterIds = [...chat.activeCharacterIds, id];
        chat.settings = normalizeSettings({ ...chat.settings, primaryCharacterId: chat.settings.primaryCharacterId || id });
      }
    }
    chat.updatedAt = Date.now();
    this.persist();
  }

  setActiveCharacters(ids: string[]) {
    const chat = this.currentChat;
    if (!chat) return;
    const valid = new Set(this.characters.map((character) => character.id));
    chat.activeCharacterIds = ids.filter((id, index, arr) => valid.has(id) && arr.indexOf(id) === index);
    chat.settings = normalizeSettings({
      ...chat.settings,
      primaryCharacterId: chat.activeCharacterIds.includes(chat.settings.primaryCharacterId || '')
        ? chat.settings.primaryCharacterId
        : chat.activeCharacterIds[0] || null
    });
    chat.updatedAt = Date.now();
    this.persist();
  }

  setAttachedLorebooks(ids: string[]) {
    const chat = this.currentChat;
    if (!chat) return;
    const valid = new Set(this.lorebooks.map((book) => book.id));
    chat.lorebookIds = ids.filter((id, index, arr) => valid.has(id) && arr.indexOf(id) === index);
    chat.updatedAt = Date.now();
    this.persist();
  }

  toggleCharacter(characterId: string) {
    const chat = this.currentChat;
    if (!chat) return;
    const ids = new Set(chat.activeCharacterIds);
    if (ids.has(characterId)) ids.delete(characterId);
    else ids.add(characterId);
    chat.activeCharacterIds = Array.from(ids);
    chat.settings = normalizeSettings({
      ...chat.settings,
      primaryCharacterId: chat.activeCharacterIds.includes(chat.settings.primaryCharacterId || '')
        ? chat.settings.primaryCharacterId
        : chat.activeCharacterIds[0] || null
    });
    chat.updatedAt = Date.now();
    this.persist();
  }

  toggleLorebook(lorebookId: string) {
    const chat = this.currentChat;
    if (!chat) return;
    const ids = new Set(chat.lorebookIds);
    if (ids.has(lorebookId)) ids.delete(lorebookId);
    else ids.add(lorebookId);
    chat.lorebookIds = Array.from(ids);
    chat.updatedAt = Date.now();
    this.persist();
  }

  toggleCharacterLorebook(characterId: string, lorebookId: string) {
    if (!this.lorebooks.some((book) => book.id === lorebookId)) return;
    this.characters = this.characters.map((character) => {
      if (character.id !== characterId) return character;
      const ids = new Set(character.attachedLorebookIds || []);
      if (ids.has(lorebookId)) ids.delete(lorebookId);
      else ids.add(lorebookId);
      return { ...character, attachedLorebookIds: Array.from(ids), updatedAt: Date.now() };
    });
    this.persist();
  }

  upsertCharacter(character: RoleplayCharacter) {
    const existing = this.characters.findIndex((entry) => entry.id === character.id);
    const nextCharacter = normalizeCharacter({ ...character, updatedAt: Date.now() });
    if (existing >= 0) this.characters[existing] = nextCharacter;
    else this.characters = [nextCharacter, ...this.characters];
    if (character.embeddedLorebook) {
      this.lorebooks = [
        character.embeddedLorebook,
        ...this.lorebooks.filter((book) => book.sourceCharacterId !== character.id)
      ];
    }
    this.persist();
  }

  createCharacter(partial: Partial<RoleplayCharacter> = {}) {
    const character = createBlankRoleplayCharacter(partial);
    this.upsertCharacter(character);
    return character;
  }

  updateCharacterImage(characterId: string, imageDataUrlOrUrl: string) {
    const value = imageDataUrlOrUrl.trim();
    if (!value) return;
    this.characters = this.characters.map((character) =>
      character.id === characterId ? { ...character, avatarDataUrl: value, updatedAt: Date.now() } : character
    );
    this.persist();
  }

  removeCharacterImage(characterId: string) {
    this.characters = this.characters.map((character) => {
      if (character.id !== characterId) return character;
      const { avatarDataUrl: _avatarDataUrl, ...rest } = character;
      return { ...rest, updatedAt: Date.now() };
    });
    this.persist();
  }

  async updateCharacterImageFromFile(characterId: string, file: File) {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
    this.updateCharacterImage(characterId, await fileToDataUrl(file));
  }

  async updateCharacterImageFromClipboard(characterId: string, clipboardData: DataTransfer | null) {
    const file = Array.from(clipboardData?.files || []).find((entry) => entry.type.startsWith('image/')) ||
      Array.from(clipboardData?.items || [])
        .find((entry) => entry.kind === 'file' && entry.type.startsWith('image/'))
        ?.getAsFile();
    if (!file) throw new Error('Clipboard does not contain an image.');
    await this.updateCharacterImageFromFile(characterId, file);
  }

  async updateCharacterImageFromUrl(characterId: string, url: string) {
    const target = url.trim();
    if (!target) return;
    try {
      const response = await fetch(target);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) throw new Error('URL did not return an image.');
      this.updateCharacterImage(characterId, await blobToDataUrl(await response.blob()));
    } catch {
      this.updateCharacterImage(characterId, target);
    }
  }

  deleteCharacter(characterId: string) {
    this.characters = this.characters.filter((character) => character.id !== characterId);
    this.lorebooks = this.lorebooks.filter((book) => book.sourceCharacterId !== characterId);
    for (const chat of this.chats) {
      chat.activeCharacterIds = chat.activeCharacterIds.filter((id) => id !== characterId);
      if (chat.settings.primaryCharacterId === characterId) {
        chat.settings = normalizeSettings({ ...chat.settings, primaryCharacterId: chat.activeCharacterIds[0] || null });
      }
      chat.lorebookIds = chat.lorebookIds.filter((id) => this.lorebooks.some((book) => book.id === id));
    }
    this.persist();
  }

  createLorebook(name = 'New lorebook') {
    const now = Date.now();
    this.lorebooks = [{
      id: createId('rp-lorebook'),
      name,
      entries: [],
      createdAt: now,
      updatedAt: now
    }, ...this.lorebooks];
    this.persist();
  }

  updateLorebook(lorebookId: string, partial: Partial<RoleplayLorebook>) {
    this.lorebooks = this.lorebooks.map((book) =>
      book.id === lorebookId ? { ...book, ...partial, updatedAt: Date.now() } : book
    );
    this.persist();
  }

  deleteLorebook(lorebookId: string) {
    this.lorebooks = this.lorebooks.filter((book) => book.id !== lorebookId);
    for (const chat of this.chats) chat.lorebookIds = chat.lorebookIds.filter((id) => id !== lorebookId);
    this.characters = this.characters.map((character) => ({
      ...character,
      attachedLorebookIds: (character.attachedLorebookIds || []).filter((id) => id !== lorebookId)
    }));
    this.persist();
  }

  async importCharacterFile(file: File) {
    const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
    const character = isPng
      ? parseRoleplayCardPng(await fileToBytes(file), await fileToDataUrl(file))
      : parseRoleplayCardJson(await file.text());
    this.upsertCharacter(character);
    return character;
  }

  async importCharacterUrl(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Import failed: HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    const isPng = contentType.includes('image/png') || url.toLowerCase().split('?')[0].endsWith('.png');
    const character = isPng
      ? parseRoleplayCardPng(new Uint8Array(await response.arrayBuffer()), url)
      : parseRoleplayCardJson(await response.text());
    this.upsertCharacter(character);
    return character;
  }

  async sendRoleplayMessage(content: string = this.currentChat?.draft || '') {
    const chat = this.currentChat;
    const text = content.trim();
    if (!chat || !text || this.loading) return;

    if (appStore.backendMode === 'local') {
      if (!appStore.selectedLocalModelPath || !appStore.localModelActive) {
        this.error = 'No local model is loaded. Select and load a model first.';
        return;
      }
    } else {
      const provider = appStore.activeProvider;
      if (!provider?.model) {
        this.error = 'No API model selected. Choose a model in settings.';
        return;
      }
      if (!provider?.has_api_key && !provider?.api_key) {
        this.error = 'Missing API key for the selected provider.';
        return;
      }
    }

    const now = Date.now();
    const userMessage: RoleplayMessage = {
      id: createId('rp-msg'),
      role: 'user',
      content: text,
      createdAt: now,
      speaker: chat.settings.userName || 'User'
    };
    const assistantMessage: RoleplayMessage = {
      id: createId('rp-msg'),
      role: 'assistant',
      content: '',
      createdAt: now + 1,
      status: 'streaming'
    };
    chat.messages = [...chat.messages, userMessage, assistantMessage];
    chat.draft = '';
    chat.title = chat.messages.length === 2 ? text.slice(0, 48) || chat.title : chat.title;
    chat.updatedAt = now;
    this.loading = true;
    this.error = null;
    const controller = new AbortController();
    this.abortController = controller;
    this.persist();

    let usage: CompletionResult['usage'] = null;
    let lastSyncTime = 0;
    let pendingSync = false;
    const syncAssistantMessage = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSyncTime < 50) {
        pendingSync = true;
        return;
      }
      pendingSync = false;
      lastSyncTime = now;
      const idx = chat.messages.findIndex((message) => message.id === assistantMessage.id);
      if (idx >= 0) {
        chat.messages[idx] = { ...assistantMessage };
        chat.messages = [...chat.messages];
        chat.updatedAt = now;
      }
    };
    const flushPendingSync = () => {
      if (!pendingSync) return;
      pendingSync = false;
      lastSyncTime = 0;
      syncAssistantMessage(true);
    };

    try {
      const modelName = appStore.activeModelLabel || 'Model';
      const promptChat = {
        ...chat,
        messages: chat.messages.filter((message) => message.id !== assistantMessage.id)
      };
      await streamAssistantReply({
        messages: buildRoleplayMessages({
          chat: promptChat,
          characters: this.characters,
          lorebooks: this.lorebooks,
          latestUserMessage: text
        }),
        signal: controller.signal,
        onChunk: (chunk) => {
          assistantMessage.content += chunk;
          chat.updatedAt = Date.now();
          syncAssistantMessage();
        },
        onReasoning: (chunk) => {
          assistantMessage.reasoning = `${assistantMessage.reasoning || ''}${chunk}`;
          syncAssistantMessage();
        },
        onUsage: (value) => {
          usage = value || usage;
        }
      });
      flushPendingSync();
      assistantMessage.model = modelName;
      assistantMessage.status = 'idle';
      syncAssistantMessage(true);
    } catch (error) {
      const message = toErrorMessage(error);
      const aborted = message.toLowerCase().includes('abort');
      assistantMessage.status = aborted ? 'idle' : 'error';
      if (!assistantMessage.content && !aborted) assistantMessage.content = message;
      this.error = aborted ? null : message;
      syncAssistantMessage(true);
    } finally {
      void usage;
      this.loading = false;
      this.abortController = null;
      chat.updatedAt = Date.now();
      this.persist();
    }
  }

  stopGeneration() {
    this.abortController?.abort();
  }
}

export const roleplayStore = new RoleplayStore();
