import type { AgentActivity, AgentArtifact, AgentOutcome, AgentStep, AgentStopReason, AppConfig, Attachment, CharacterCard, ChatContextMode, ChatFolder, ChatMessage, ChatSession, CreatedFile, LocalThinkingMode, LorebookEntry, MessageVersion, ModelOption, ReasoningCapabilities, ReasoningLevel, RoleplayJournalEntry, RoleplaySettings, RoleplayWorld, SearchMeta, WorkspaceFile } from '$lib/types/chat';
import { SPACES } from '$lib/spaces';
import { approvalsStore } from '$lib/stores/approvals.svelte';
import type { IndexedDocument, SearchResult } from '$lib/types/bridge';
import { countOf } from '$lib/utils/format';
import { runAgentTask } from '$lib/services/agent';
import { resolveComposerRoute, shouldUseToolLoop } from '$lib/services/composer-route';
import { humanizeAgentError } from '$lib/utils/errors';
import type { RunAgentTaskArgs } from '$lib/services/agent-types';
import { parseSlidesFromMarkdown } from '$lib/services/slides';
import { writeTempFile, pathExists, pickWorkspaceFolder as pickWorkspaceFolderDialog, indexWorkspaceFolder, writeWorkspaceFile, createWorkspaceDocument, renameWorkspaceFile, deleteWorkspaceFile, readWorkspaceFile, openWorkspaceFile, createWorkspaceFolder } from '$lib/services/files';
import { clearRagDocuments, ingestDocument, ingestText, ingestTextFast, listRagDocuments, queryDocuments, removeRagDocument } from '$lib/services/rag';
import { webSearch } from '$lib/services/search';
import { getRecommendedSettings, loadLocalModel, onSupervisorEvent, stopLlama } from '$lib/services/runtime';
import { isElectron } from '$lib/services/bridge';
import { downloadsStore } from '$lib/stores/downloads.svelte';
import { deepResearchStore } from '$lib/stores/deep-research.svelte';
import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
import { modelsStore } from '$lib/stores/models.svelte';
import { ttsStore } from '$lib/stores/tts.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import type { CompletionResult, RequestMessage } from '$lib/services/chat-api';
import { completeAssistantReply, detectToolSupport, fetchModels, fetchReasoningCapabilities, hasConfiguredVisionModel, loadChatConfig, reasoningRouteIdentity, streamAssistantReply } from '$lib/services/chat-api';
import { loadChatState, saveChatState, saveAppConfig, saveChatStateToDb, loadChatStateFromDb, deleteChatFromDb } from '$lib/utils/storage';
import { toErrorMessage } from '$lib/utils/errors';
import { resolveContextBudgetPreview } from '$lib/stores/app-context-budget-preview';
import { buildSearchSystemPrefix, buildSystemPrompt, selectBaseSystemPrompt } from '$lib/stores/app-prompts';
import { charactersStore, greetingsFor } from '$lib/features/roleplay/characters.svelte';
import { worldsStore } from '$lib/features/roleplay/worlds.svelte';
import { selectNextSpeaker } from '$lib/features/roleplay/group-turn';
import { buildRoleplayStopStrings, stripSpeakerPrefix, stripTrailingPartialStop } from '$lib/features/roleplay/roleplay-output';
import { extractRoleplayChoices, stripRoleplayChoiceBlock } from '$lib/features/roleplay/roleplay-choices';
import { extractRoleplayProps, stripRoleplayPropBlock, type RoleplayProp } from '$lib/features/roleplay/roleplay-props';
import { makeSilenceTurn, makeTwistTurn, pickTwist, type StoryTurn } from '$lib/features/roleplay/roleplay-twists';
import {
  buildRoleplaySystemPrompt as composeRoleplayPrompt,
  resolveLorebooks,
  resolveRoleplaySampling,
  type RoleplaySampling
} from '$lib/services/roleplay-prompts';
import {
  applyLocalContextBudgetTruncation,
  appendRoleplayNudge,
  appendRoleplayStoryTurn,
  buildOutboundMessages,
  buildRequestMessagesWithPatchedUser,
  type RoleplayAttribution
} from '$lib/stores/app-message-pipeline';
import {
  buildApiModelMetadataCacheKey,
  fetchApiModelMetadataFromProvider,
  getCachedOrFetchApiModelMetadata
} from '$lib/stores/app-model-metadata';
import {
  mergeLocalSettingsConfig,
  mergePromptSettingsConfig,
  mergeProviderConfig,
  mergeSearchSettingsConfig,
  mergeTtsSettingsConfig,
  mergeUiSettingsConfig,
  setBackendModeConfig,
  setLocalModelConfig
} from '$lib/stores/app-store-config';
import { findLatestArtifactMessage, resolveArtifactForMessage, upsertArtifactOnMessage } from '$lib/stores/app-store-artifacts';
import {
  buildLocalModelRuntimeRequest,
  buildLocalModelSettingsPatch,
  buildRememberedLocalModelSettingsEntry,
  pickNumber,
  readRememberedLocalModelSettings,
  resolveLocalModelLoadState,
  writeRememberedLocalModelSettings
} from '$lib/stores/app-store-local-model';
import {
  buildWorkspaceFromIndexResult,
  buildWorkspacePrompt,
  getWorkspaceExtension,
  getWorkspacePath,
  isSupportedWorkspaceFile,
  recalculateWorkspace,
  shouldIgnoreWorkspacePath,
  trimWorkspaceText
} from '$lib/stores/app-store-workspace';
import type {
  ActiveGenerationRun,
  ChatSearchState,
  GenerationBackendMode,
  GenerationComposerMode,
  LocalModelLoadTarget,
  PersistedState
} from '$lib/stores/app-store-types';
import { buildLocalModelOption } from '$lib/utils/local-models';
import { activityLabel } from '$lib/utils/tool-ui';
import { createId } from '$lib/utils/id';

import {
  USER_NAME_KEY,
  WEB_RAG_MIN_ANSWER_CHARS,
  WORKSPACE_MAX_FILES,
  WORKSPACE_MAX_FILE_SIZE_BYTES,
  activityFromProgress,
  agentOutcome,
  agentStopReason,
  appendStreamingContent,
  appendStreamingReasoning,
  buildContextualPrompt as buildContextualPromptHelper,
  buildRequestMessagesFromHistory,
  canStartGeneration as canStartGenerationHelper,
  buildSearchConversationContext,
  buildWebRagPayload,
  executionMetadata,
  finalizeAssistantMetadata,
  getElectronApi,
  getMessageRequestContent,
  hasUsableAgentResult,
  isAbortLikeError,
  markAgentWriting,
  markAgentStopped,
  normalizeChat,
  normalizeContextMode,
  normalizeFolder,
  normalizeMessage,
  normalizeSessionComposerMode,
  normalizeSessionSearchMode,
  normalizeText,
  optimisticAck,
  parseWriteFileBlocks,
  readBlobAsDataUrl,
  repairRoleplayChat,
  setAgentActivity,
  startReasoningTimer,
  stripWriteFileBlocks,
  toInvoke,
  updateStreamingVersion,
  withTimeout,
  isDefaultChatTitle,
  type ApiModelMetadata,
  type AssistantMetadata,
  type ContextBudget,
  type ElectronApi
} from '$lib/stores/app-store-helpers';

class AppStore {
  ready = $state(false);
  config = $state<AppConfig>({});
  chats = $state<ChatSession[]>([]);
  folders = $state<ChatFolder[]>([]);
  currentChatId = $state<string | null>(null);
  activeSpace = $state<ChatContextMode>('home');
  currentChatIdBySpace = $state<Record<ChatContextMode, string | null>>({ home: null, code: null, roleplay: null });
  composer = $state('');
  models = $state<ModelOption[]>([]);
  modelsRefreshing = $state(false);
  _apiModelsCache = new Map<string, ModelOption[]>();
  modelMenuOpen = $state(false);
  settingsOpen = $state(false);
  promptConfigOpen = $state(false);
  modelManagerOpen = $state(false);
  modelManagerOpenModelId = $state<string | null>(null);
  modelManagerOpenSection = $state<string | null>(null);
  runtimeManagerOpen = $state(false);
  agentWorkspaceOpen = $state(false);
  artifactStudioOpen = $state(false);
  artifactSettingsOpen = $state(false);
  llmDrawerOpen = $state(false);
  sidebarOpen = $state(true);
  chatSearchOpen = $state(false);
  searchSidebarOpen = $state(false);
  searchStateByChat = $state<Record<string, ChatSearchState>>({});
  voiceModeActive = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  abortController = $state<AbortController | null>(null);
  activeRunsByChat = $state<Record<string, ActiveGenerationRun>>({});
  editingMessageId = $state<string | null>(null);
  editingMessageContent = $state('');
  searchMode = $state<'chat' | 'search' | 'deep' | 'max'>('chat');
  reasoningLevel = $state<ReasoningLevel | null>(null);
  reasoningCapabilities = $state<ReasoningCapabilities>({ supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' });
  composerMode = $state<'chat' | 'instant' | 'agent'>('agent');
  pendingAttachments = $state<Attachment[]>([]);
  workspaceIndexing = $state(false);
  ragDocumentsByChat = $state<Record<string, IndexedDocument[]>>({});
  contextBudget = $state<ContextBudget | null>(null);
  apiModelMetadataByKey = $state<Record<string, ApiModelMetadata>>({});
  currentArtifact = $state<AgentArtifact | null>(null);
  currentArtifactMessageId = $state<string | null>(null);
  activityDrawerOpen = $state(false);
  activityMessageId = $state<string | null>(null);
  activityDrawerTab = $state<'activity' | 'sources'>('activity');
  /** Per-code-chat drawer open state (isolated across sessions). */

  localModelLoadTarget = $state<LocalModelLoadTarget | null>(null);
  // Empty means auto: llama.cpp's --fit sizes these against real device memory.
  localModelLoadContextLength = $state('');
  localModelLoadGpuLayers = $state('');
  localModelLoadCpuThreads = $state('4');
  localModelLoadBatchSize = $state('512');
  localModelLoadRuntimePath = $state('');
  localModelLoadFlashAttention = $state(true);
  localModelLoadOffloadKvCache = $state(true);
  localModelLoadKeepInMemory = $state(true);
  localModelLoadMmap = $state(true);
  localModelLoadSeed = $state('');
  localModelLoadParallel = $state('1');
  localModelLoadRopeFreqBase = $state('');
  localModelLoadRopeFreqScale = $state('');
  localModelLoadCacheTypeK = $state('f16');
  localModelLoadCacheTypeV = $state('f16');
  localModelLoadMmprojPath = $state('');
  /** Thinking default for this load: 'auto' omits --reasoning (server detects). */
  localModelLoadThinkingMode = $state<LocalThinkingMode>('auto');
  localModelLoadMtpEnabled = $state(false);
  localModelLoadMtpDraftPath = $state('');
  localModelLoadMtpDraftNMax = $state('');
  localModelLoadCpuMoe = $state(false);
  localModelLoadNCpuMoe = $state('');
  localModelLoadContextShift = $state(false);
  localModelLoadCacheRamMb = $state('');
  localModelLoadCacheReuse = $state('');
  localModelLoadSwaFull = $state(false);
  localModelLoadSplitMode = $state('');
  localModelRememberSettings = $state(false);
  localModelLoadProgress = $state(0);
  localModelLoadPhase = $state('');
  localModelLoading = $state(false);
  localModelActive = $state<{ name: string; path: string; hasMmproj: boolean } | null>(null);
  onboardingOpen = $state(false);
  onboardingCompleted = $state(false);
  userName = $state(typeof localStorage !== 'undefined' ? (localStorage.getItem(USER_NAME_KEY) || '') : '');
  private closeWorkFingerprint = '';
  private contextBudgetRequestId = 0;
  /** Chat ids that must be flushed to SQLite on next persist (not only current/running). */
  private dirtyChatIds = new Set<string>();

  get currentChat() {
    return this.chats.find((chat) => chat.id === this.currentChatId) || null;
  }

  get activeProviderName() {
    return this.config.llm?.provider || 'openai';
  }

  get backendMode() {
    return this.config.llm?.backend_mode || (isElectron() ? 'local' : 'api');
  }

  get activeProvider() {
    return this.config.llm?.providers?.[this.activeProviderName] || null;
  }

  get activeModelLabel() {
    if (this.backendMode === 'local') {
      return this.config.llm?.local?.model || 'No model';
    }
    return this.activeProvider?.model || 'No model';
  }

  get currentRun() {
    return this.currentChatId ? (this.activeRunsByChat[this.currentChatId] || null) : null;
  }

  get activityMessage() {
    const messageId = this.activityMessageId;
    if (!messageId) return null;
    return this.currentChat?.messages?.find((message) => message.id === messageId) || null;
  }

  get currentChatGenerating() {
    return !!this.currentRun;
  }

  get hasAnyGeneration() {
    return Object.keys(this.activeRunsByChat).length > 0;
  }

  isChatGenerating(chatId = this.currentChatId || '') {
    return !!(chatId && this.activeRunsByChat[chatId]);
  }

  hasOtherChatGeneration(chatId = this.currentChatId || '') {
    return Object.keys(this.activeRunsByChat).some((id) => id !== chatId);
  }

  get currentChatBlockedByOtherLocalRun() {
    return this.backendMode === 'local' && this.hasOtherChatGeneration(this.currentChatId || '');
  }

  get hasActiveWork() {
    return this.hasAnyGeneration || this.localModelLoading || downloadsStore.hasActive;
  }

  get activeWorkReasons() {
    const reasons: string[] = [];
    if (this.hasAnyGeneration) reasons.push('chat generation');
    if (this.localModelLoading) reasons.push('model loading');
    if (downloadsStore.hasActive) reasons.push('downloads');
    return reasons;
  }

  async syncWindowActiveWork() {
    if (!isElectron() || typeof window === 'undefined' || !window.electronAPI?.windowSetActiveWork) return;
    const payload = {
      active: this.hasActiveWork,
      reasons: this.activeWorkReasons
    };
    const fingerprint = JSON.stringify(payload);
    if (fingerprint === this.closeWorkFingerprint) return;
    this.closeWorkFingerprint = fingerprint;
    try {
      await window.electronAPI.windowSetActiveWork(payload.active, payload.reasons);
    } catch {
      // no-op for close guard sync failures
    }
  }

  private refreshGenerationState() {
    const runs = Object.values(this.activeRunsByChat);
    this.loading = runs.length > 0;
    /*
     * Only ever the *current* chat's controller.
     *
     * This used to fall back to `runs[0]?.controller`, so while viewing an idle chat
     * during another chat's run, `appStore.abortController` pointed at that other
     * chat. Anything reaching for the store-level controller — a stop button, an
     * unmount cleanup — aborted a background run the user never asked to stop.
     */
    this.abortController = this.currentRun?.controller || null;
  }

  private beginGenerationRun(chatId: string, run: ActiveGenerationRun) {
    this.activeRunsByChat = {
      ...this.activeRunsByChat,
      [chatId]: run
    };
    this.refreshGenerationState();
  }

  private endGenerationRun(chatId: string, controller?: AbortController) {
    const existing = this.activeRunsByChat[chatId];
    if (!existing) {
      this.refreshGenerationState();
      return;
    }
    if (controller && existing.controller !== controller) return;
    const next = { ...this.activeRunsByChat };
    delete next[chatId];
    this.activeRunsByChat = next;
    // Deny anything still waiting. This is the one hook covering completion,
    // abort and error alike; without it a torn-down run left its approval
    // promises pending forever. Placed past the controller guard above so a
    // stale controller cannot deny a live run's approvals.
    approvalsStore.clearForChat(chatId);
    this.refreshGenerationState();
  }

  private queueWebAnswerRagIngest(params: { chatId: string; query: string; answer: string; sources: SearchResult[] }) {
    if (!isElectron()) return;
    const normalizedAnswer = normalizeText(params.answer);
    if (normalizedAnswer.length < WEB_RAG_MIN_ANSWER_CHARS) return;

    const text = buildWebRagPayload({
      query: params.query,
      answer: normalizedAnswer,
      sources: params.sources || []
    });
    if (!text) return;

    const sourceLabel = normalizeText(params.query).slice(0, 80) || 'web-answer';
    void ingestTextFast({
      source: `web_answer:${sourceLabel}`,
      text,
      chat_id: params.chatId,
      file_type: 'web_answer',
      chunk_size: 900
    }).catch((error) => {
      console.warn('[RAG] Background web answer ingest failed', error);
    });
  }

  get selectedLocalModelPath() {
    return this.config.llm?.local?.selected_model_path || '';
  }

  get currentContextMode() {
    return this.currentChat?.contextMode || this.activeSpace || 'home';
  }

  get visibleChats() {
    return this.getSessionsForSpace(this.activeSpace);
  }

  /** Clear space separation: home sessions only. Code uses visibleCodeChats. */
  get visibleHomeChats() {
    return this.getSessionsForSpace('home');
  }

  /** Clear space separation: code sessions only. Home uses visibleHomeChats. */
  get visibleCodeChats() {
    return this.getSessionsForSpace('code');
  }

  /** Roleplay sessions only. */
  get visibleRoleplayChats() {
    return this.getSessionsForSpace('roleplay');
  }

  getSessionsForSpace(space: ChatContextMode) {
    return this.chats.filter((chat) => normalizeContextMode(chat.contextMode) === space);
  }

  get currentWorkspace() {
    return this.currentChat?.workspace || null;
  }

  get currentRagDocuments() {
    if (!this.currentChatId) return [];
    return this.ragDocumentsByChat[this.currentChatId] || [];
  }

  get currentSearchState() {
    return this.getSearchStateForChat(this.currentChatId || '');
  }

  getSearchStateForChat(chatId: string): ChatSearchState {
    if (!chatId) return { results: [], loading: false, query: '' };
    return this.searchStateByChat[chatId] || { results: [], loading: false, query: '' };
  }

  private setSearchStateForChat(chatId: string, patch: Partial<ChatSearchState>) {
    if (!chatId) return;
    const current = this.getSearchStateForChat(chatId);
    this.searchStateByChat = {
      ...this.searchStateByChat,
      [chatId]: {
        ...current,
        ...patch
      }
    };
  }

  async refreshContextBudgetPreview() {
    if (!isElectron() || typeof window === 'undefined' || !window.electronAPI?.invoke) {
      this.contextBudget = null;
      return;
    }

    const chat = this.currentChat;
    if (!chat) {
      this.contextBudget = null;
      return;
    }

    const requestId = ++this.contextBudgetRequestId;

    const draftContent = this.composer.trim();
    const workspaceContext = this.currentContextMode === 'code' && this.currentWorkspace
      ? buildWorkspacePrompt(this.currentWorkspace)
      : '';

    const currentMessages = buildRequestMessagesFromHistory(chat.messages);
    if (draftContent || this.pendingAttachments.length > 0) {
      currentMessages.push({
        role: 'user',
        content: this.buildContextualPrompt({
          content: draftContent,
          workspaceContext,
          mode: this.composerMode,
          searchMode: this.searchMode
        }),
        attachments: this.pendingAttachments
      });
    }

    const systemPrompt = this.getSystemPrompt();
    const outboundMessages = buildOutboundMessages({ messages: currentMessages, systemPrompt });
    try {
      const electronApi = getElectronApi();
      if (!electronApi) {
        this.contextBudget = null;
        return;
      }

      const provider = this.activeProvider;
      const budget = await resolveContextBudgetPreview({
        backendMode: this.backendMode,
        invoke: toInvoke(electronApi),
        messages: outboundMessages,
        localContextLength: this.config.llm?.local?.context_length,
        localMaxTokens: this.config.llm?.local?.max_tokens,
        providerMaxTokens: provider?.max_tokens,
        activeProviderModel: provider?.model,
        activeProviderName: this.activeProviderName,
        readCachedMetadata: (cacheKey) => this.apiModelMetadataByKey[cacheKey] || null,
        fetchMetadata: (providerName, model) => this.fetchApiModelMetadata(providerName, model)
      });

      if (requestId !== this.contextBudgetRequestId) return;
      this.contextBudget = budget;
    } catch {
      if (requestId === this.contextBudgetRequestId) {
        this.contextBudget = null;
      }
    }
  }

  private async fetchApiModelMetadata(providerName: string, model: string): Promise<ApiModelMetadata | null> {
    if (!isElectron() || typeof window === 'undefined' || !window.electronAPI?.invoke) {
      return null;
    }

    const cacheKey = buildApiModelMetadataCacheKey(providerName, model);

    const provider = this.activeProvider;
    if (!provider) return null;

    try {
      const metadata = await getCachedOrFetchApiModelMetadata({
        providerName,
        model,
        cache: this.apiModelMetadataByKey,
        fetchFresh: async () => {
          const electronApi = getElectronApi();
          if (!electronApi) return null;
          return fetchApiModelMetadataFromProvider({
            invoke: toInvoke(electronApi),
            providerName,
            model,
            baseUrl: provider.base_url || '',
            apiKey: provider.api_key || ''
          });
        }
      });
      if (metadata) {
        this.apiModelMetadataByKey = { ...this.apiModelMetadataByKey, [cacheKey]: metadata };
        return metadata;
      }
    } catch {
      // ignore
    }

    return null;
  }

  private getSystemPrompt(): string {
    return this.buildSystemPromptForMode({
      backendMode: this.backendMode,
      providerPrompt: this.config.llm?.providers?.[this.activeProviderName]?.system_prompt,
      includeChartHint: true,
      chat: this.currentChat
    });
  }

  /**
   * Roleplay sessions never receive the assistant system prompt: character
   * card, persona, lorebook and author's note compose the whole instruction
   * block (see services/roleplay-prompts).
   */
  private roleplayPromptParts(
    chat: ChatSession | null,
    speakerId?: string | null
  ): {
    systemPrompt: string;
    loreEntries: LorebookEntry[];
    speaker: CharacterCard | null;
    sampling: RoleplaySampling;
    stop: string[];
  } {
    const primary = charactersStore.getById(chat?.characterId);
    const rosterIds = chat?.roleplay?.characterIds?.length
      ? chat.roleplay.characterIds
      : primary
        ? [primary.id]
        : [];
    const characters = rosterIds
      .map((id) => charactersStore.getById(id))
      .filter((card): card is CharacterCard => !!card);
    if (!characters.length && primary) characters.push(primary);

    const persona = charactersStore.getPersonaById(chat?.personaId) ?? charactersStore.defaultPersona;
    const world = worldsStore.getById(chat?.worldId);

    const scanDepth = Math.max(1, primary?.book?.scanDepth || 0, world?.book?.scanDepth || 0) || 4;
    const scanText = (chat?.messages || [])
      .slice(-scanDepth)
      .map((message) => message.content || '')
      .join('\n');
    // World canon first, then each cast member's own book; one shared budget.
    const loreEntries = resolveLorebooks(
      [
        { book: world?.book, source: 'world' },
        ...characters.map((character) => ({
          book: character.book,
          source: 'character' as const,
          characterId: character.id
        }))
      ],
      scanText
    );

    const speaker = charactersStore.getById(speakerId ?? this.roleplaySpeakerId(chat)) || primary;
    const systemPrompt = composeRoleplayPrompt({
      characters,
      speaker,
      persona,
      userName: this.userName,
      loreEntries,
      authorNote: chat?.roleplay?.authorNote,
      group: characters.length > 1,
      allowMultiSpeaker: !!chat?.roleplay?.allowMultiSpeaker,
      adventureChoices: !!chat?.roleplay?.adventureChoices,
      props: !!chat?.roleplay?.props,
      worldName: world?.name,
      worldOverview: world?.overview,
      worldScenario: world?.scenario,
      contentRating: chat?.roleplay?.contentRating
    });

    const sampling = resolveRoleplaySampling({
      speaker: speaker || null,
      chatSettings: chat?.roleplay,
      worldSettings: world?.settings
    });

    /*
     * Stop strings end a reply at the first line that is not its own — the only
     * real defence against the model writing the user's turn. The name has to
     * match the one macro substitution put in the prompt, so the resolution
     * below mirrors `buildRoleplaySystemPrompt` exactly.
     */
    const stop = buildRoleplayStopStrings({
      userName: persona?.name?.trim() || this.userName?.trim() || 'User',
      speakerName: speaker?.name,
      castNames: characters.map((card) => card.name),
      allowMultiSpeaker: !!chat?.roleplay?.allowMultiSpeaker
    });

    return { systemPrompt, loreEntries, speaker: speaker || null, sampling, stop };
  }

  private buildRoleplaySystemPrompt(chat: ChatSession | null, speakerId?: string | null): string {
    return this.roleplayPromptParts(chat, speakerId).systemPrompt;
  }

  /**
   * Everything a roleplay turn carries besides its prompt: sampling overrides,
   * the stop strings, and any story turn queued for it — a thrown twist, or the
   * silence of a choice that ran out. Empty outside roleplay so callers can pass
   * it along unconditionally.
   *
   * Reading this consumes the queued story turn. One turn, one generation.
   */
  private roleplayRequestOverrides(
    chat: ChatSession | null,
    speakerId?: string | null
  ): { sampling: RoleplaySampling; stop: string[]; storyTurn?: StoryTurn } {
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return { sampling: {}, stop: [] };
    const parts = this.roleplayPromptParts(chat, speakerId);
    return {
      sampling: parts.sampling,
      stop: parts.stop,
      storyTurn: this.takeRoleplayStoryTurn(chat.id)
    };
  }

  /** The two names that macros and story turns resolve against. */
  private roleplayNames(chat: ChatSession | null): { char: string; user: string } {
    const speaker = charactersStore.getById(this.roleplaySpeakerId(chat))
      || charactersStore.getById(chat?.characterId);
    const persona = charactersStore.getPersonaById(chat?.personaId) ?? charactersStore.defaultPersona;
    return {
      char: speaker?.name?.trim() || 'the character',
      user: persona?.name?.trim() || this.userName?.trim() || 'User'
    };
  }

  /**
   * What a roleplay turn sends, for the prompt inspector: the composed system
   * prompt, the lore entries that fired, and the speaker.
   */
  previewRoleplayPrompt(messageId?: string | null) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') {
      return { systemPrompt: '', loreEntries: [] as LorebookEntry[], speaker: null as CharacterCard | null };
    }
    const messageSpeakerId = messageId
      ? chat.messages.find((message) => message.id === messageId)?.speakerId || null
      : null;
    return this.roleplayPromptParts(chat, messageSpeakerId);
  }

  private buildSystemPromptForMode(args: {
    backendMode: GenerationBackendMode;
    providerPrompt?: string;
    includeChartHint?: boolean;
    searchSystemPrefix?: string;
    chat?: ChatSession | null;
    /** Roleplay: the character whose reply is being generated. */
    speakerId?: string | null;
  }): string {
    const chat = args.chat ?? this.currentChat;
    if (normalizeContextMode(chat?.contextMode) === 'roleplay') {
      return this.buildRoleplaySystemPrompt(chat, args.speakerId);
    }
    const basePrompt = selectBaseSystemPrompt({
      backendMode: args.backendMode,
      localPrompt: this.config.llm?.local?.system_prompt,
      providerPrompt: args.providerPrompt,
      globalPrompt: this.config.llm?.system_prompt
    });
    return buildSystemPrompt({
      basePrompt,
      userName: this.userName,
      searchSystemPrefix: args.searchSystemPrefix,
      includeChartHint: args.includeChartHint
    });
  }

  private syncArtifactState(artifact: AgentArtifact | null, messageId: string | null = this.currentArtifactMessageId, open = this.artifactStudioOpen) {
    this.currentArtifact = artifact;
    this.currentArtifactMessageId = artifact ? messageId : null;

    if (upsertArtifactOnMessage(this.currentChat, messageId, artifact)) {
      this.touchChats();
      this.persist();
    }

    this.artifactStudioOpen = artifact ? open : false;
  }

  openArtifact(artifact: AgentArtifact | null, messageId: string | null = null) {
    if (!artifact && messageId && this.currentChat) {
      artifact = resolveArtifactForMessage(this.currentChat, messageId);
    }
    if (!artifact) return;
    this.syncArtifactState(artifact, messageId, true);
  }

  setCurrentArtifact(artifact: AgentArtifact | null, messageId: string | null = this.currentArtifactMessageId, open = this.artifactStudioOpen) {
    this.syncArtifactState(artifact, messageId, open);
  }

  saveArtifactToMessage(chatId: string, messageId: string, artifact: AgentArtifact): boolean {
    const chat = this.findChat(chatId);
    if (!upsertArtifactOnMessage(chat, messageId, artifact)) return false;
    this.markChatDirty(chatId);
    this.touchChats(chatId);
    if (this.currentChatId === chatId) {
      this.currentArtifact = resolveArtifactForMessage(chat, messageId);
      this.currentArtifactMessageId = messageId;
    }
    this.persist();
    return true;
  }

  openActivityDrawer(messageId: string, tab: 'activity' | 'sources' = 'activity') {
    if (!messageId) return;
    // Only open for messages that belong to the current chat
    if (this.currentChat && !this.currentChat.messages.some((m) => m.id === messageId)) {
      return;
    }
    if (this.activityDrawerOpen && this.activityMessageId === messageId && this.activityDrawerTab === tab) {
      this.closeActivityDrawer();
      return;
    }
    this.activityMessageId = messageId;
    this.activityDrawerTab = tab;
    this.activityDrawerOpen = true;
  }

  closeActivityDrawer() {
    this.activityDrawerOpen = false;
  }

  async openLocalModelLoadDialog(model: LocalModelLoadTarget) {
    if (!model.path) return;
    this.localModelLoadTarget = model;
    this.localModelLoadRuntimePath = this.config.llm?.local?.runtime_path || '';
    this.localModelLoadProgress = 0;
    this.localModelLoadPhase = '';
    // Auto-detect mmproj in same folder
    this.localModelLoadMmprojPath = '';
    this.localModelLoadMmprojPath = await this.detectMmprojForModel(model.path);
    const remembered = readRememberedLocalModelSettings()[model.id] || {};
    let recommended: Awaited<ReturnType<typeof getRecommendedSettings>> | null = null;
    try {
      const hasRememberedContext = Object.prototype.hasOwnProperty.call(remembered, 'context_length');
      const hasRememberedGpu = Object.prototype.hasOwnProperty.call(remembered, 'gpu_offload');
      const recommendedContextHint = hasRememberedContext ? pickNumber(remembered.context_length) : undefined;
      const recommendedGpuHint = hasRememberedGpu ? pickNumber(remembered.gpu_offload) : undefined;
      recommended = await getRecommendedSettings(
        model.path,
        recommendedContextHint,
        recommendedGpuHint,
        this.localModelLoadRuntimePath || this.config.llm?.local?.runtime_path
      );
    } catch {
      recommended = null;
    }
    const resolved = resolveLocalModelLoadState({
      remembered,
      config: this.config,
      model,
      runtimePath: this.localModelLoadRuntimePath,
      recommended,
      hardwareConcurrency: navigator.hardwareConcurrency,
      mmprojPath: this.localModelLoadMmprojPath
    });
    this.localModelLoadContextLength = resolved.contextLength;
    this.localModelLoadGpuLayers = resolved.gpuLayers;
    this.localModelLoadCpuThreads = resolved.cpuThreads;
    this.localModelLoadBatchSize = resolved.batchSize;
    this.localModelLoadFlashAttention = resolved.flashAttention;
    this.localModelLoadOffloadKvCache = resolved.offloadKvCache;
    this.localModelLoadKeepInMemory = resolved.keepInMemory;
    this.localModelLoadMmap = resolved.mmap;
    this.localModelLoadSeed = resolved.seed;
    this.localModelLoadParallel = resolved.parallel;
    this.localModelLoadRopeFreqBase = resolved.ropeFreqBase;
    this.localModelLoadRopeFreqScale = resolved.ropeFreqScale;
    this.localModelLoadCacheTypeK = resolved.cacheTypeK;
    this.localModelLoadCacheTypeV = resolved.cacheTypeV;
    this.localModelLoadMmprojPath = resolved.mmprojPath;
    this.localModelLoadThinkingMode = resolved.thinkingMode;
    this.localModelLoadMtpEnabled = resolved.mtpEnabled;
    this.localModelLoadMtpDraftPath = resolved.mtpDraftPath;
    this.localModelLoadMtpDraftNMax = resolved.mtpDraftNMax;
    this.localModelLoadCpuMoe = resolved.cpuMoe;
    this.localModelLoadNCpuMoe = resolved.nCpuMoe;
    this.localModelLoadContextShift = resolved.contextShift;
    this.localModelLoadCacheRamMb = resolved.cacheRamMb;
    this.localModelLoadCacheReuse = resolved.cacheReuse;
    this.localModelLoadSwaFull = resolved.swaFull;
    this.localModelLoadSplitMode = resolved.splitMode;
    this.localModelRememberSettings = resolved.rememberSettings;
  }

  closeLocalModelLoadDialog() {
    this.localModelLoadTarget = null;
    this.localModelLoadProgress = 0;
    this.localModelLoadPhase = '';
  }

  async detectMmprojForModel(modelPath: string): Promise<string> {
    const candidates = await this.listProjectorCandidates(modelPath);
    return candidates[0] || '';
  }

  async listProjectorCandidates(modelPath: string): Promise<string[]> {
    if (!modelPath) return [];
    let dir = modelPath.replace(/[/\\][^/\\]+$/, '');
    try {
      const direct = await pathExists(modelPath);
      if (direct && !/\.gguf$/i.test(modelPath)) {
        dir = modelPath;
      }
    } catch {
      // ignore path probing errors
    }
    const normalizedDir = dir.replace(/\\/g, '/');
    const windowsDir = dir.replace(/\//g, '\\');
    const orderedNames = [
      'mmproj-BF16.gguf',
      'mmproj-F16.gguf',
      'mmproj-F32.gguf',
      'mmproj.gguf'
    ];
    const modelBase = (modelPath.split(/[/\\]/).pop() || '').replace(/\.gguf$/i, '');
    if (modelBase) {
      orderedNames.push(
        `mmproj-${modelBase}.gguf`,
        `${modelBase}-mmproj.gguf`,
        `${modelBase}.mmproj.gguf`,
        `${modelBase}.projector.gguf`,
        `projector-${modelBase}.gguf`
      );
    }

    const found: string[] = [];
    for (const name of orderedNames) {
      const fullPathCandidates = Array.from(new Set([
        `${normalizedDir}/${name}`,
        `${windowsDir}\\${name}`,
        `${dir}/${name}`,
        `${dir}\\${name}`
      ]));
      for (const fullPath of fullPathCandidates) {
        try {
          const exists = await pathExists(fullPath);
          if (exists && !found.includes(fullPath)) found.push(fullPath);
        } catch { /* ignore */ }
      }
    }
    return found;
  }

  /**
   * Mirrors llama-server's real startup stages onto the load dialog while the
   * launch is in flight. Returns an unsubscribe function; the caller owns it.
   *
   * The server's own 0-100 scale is remapped into the 24-95 band the dialog
   * has already reserved for the launch step.
   */
  private async subscribeToLoadProgress(): Promise<() => void> {
    if (!isElectron()) return () => {};
    try {
      const unlisten = await onSupervisorEvent((event) => {
        const progress = Number((event as { load_progress?: unknown }).load_progress);
        const phase = (event as { load_phase?: unknown }).load_phase;
        if (Number.isFinite(progress) && progress > 0) {
          this.localModelLoadProgress = Math.min(95, 24 + Math.round(progress * 0.71));
        }
        if (typeof phase === 'string' && phase) this.localModelLoadPhase = phase;
      });
      return unlisten;
    } catch {
      return () => {};
    }
  }

  async confirmLocalModelLoad() {
    if (!this.localModelLoadTarget?.path) return;
    this.localModelLoading = true;
    this.localModelLoadProgress = 5;
    this.localModelLoadPhase = 'Preparing load configuration';
    try {
      // Re-detect mmproj in case it wasn't found during dialog open
      if (!this.localModelLoadMmprojPath && this.localModelLoadTarget.path) {
        this.localModelLoadMmprojPath = await this.detectMmprojForModel(this.localModelLoadTarget.path);
      }
      await this.setBackendMode('local');
      this.localModelLoadProgress = 12;
      this.localModelLoadPhase = 'Saving local model selection';
      await this.updateLocalModel({
        id: this.localModelLoadTarget.id,
        name: this.localModelLoadTarget.name,
        path: this.localModelLoadTarget.path,
        source: 'local',
        details: this.localModelLoadTarget.details
      });
      const loadState = {
        contextLength: this.localModelLoadContextLength,
        gpuLayers: this.localModelLoadGpuLayers,
        cpuThreads: this.localModelLoadCpuThreads,
        batchSize: this.localModelLoadBatchSize,
        runtimePath: this.localModelLoadRuntimePath,
        flashAttention: this.localModelLoadFlashAttention,
        offloadKvCache: this.localModelLoadOffloadKvCache,
        keepInMemory: this.localModelLoadKeepInMemory,
        mmap: this.localModelLoadMmap,
        seed: this.localModelLoadSeed,
        parallel: this.localModelLoadParallel,
        ropeFreqBase: this.localModelLoadRopeFreqBase,
        ropeFreqScale: this.localModelLoadRopeFreqScale,
        cacheTypeK: this.localModelLoadCacheTypeK,
        cacheTypeV: this.localModelLoadCacheTypeV,
        mmprojPath: this.localModelLoadMmprojPath,
        thinkingMode: this.localModelLoadThinkingMode,
        mtpEnabled: this.localModelLoadMtpEnabled,
        mtpDraftPath: this.localModelLoadMtpDraftPath,
        mtpDraftNMax: this.localModelLoadMtpDraftNMax,
        cpuMoe: this.localModelLoadCpuMoe,
        nCpuMoe: this.localModelLoadNCpuMoe,
        contextShift: this.localModelLoadContextShift,
        cacheRamMb: this.localModelLoadCacheRamMb,
        cacheReuse: this.localModelLoadCacheReuse,
        swaFull: this.localModelLoadSwaFull,
        splitMode: this.localModelLoadSplitMode,
        rememberSettings: this.localModelRememberSettings
      };
      await this.updateLocalSettings(buildLocalModelSettingsPatch(loadState));
      const remembered = readRememberedLocalModelSettings();
      if (this.localModelRememberSettings) {
        remembered[this.localModelLoadTarget.id] = buildRememberedLocalModelSettingsEntry(loadState);
      } else {
        delete remembered[this.localModelLoadTarget.id];
      }
      writeRememberedLocalModelSettings(remembered);
      const config = await loadChatConfig();
      this.localModelLoadProgress = 24;
      this.localModelLoadPhase = 'Launching local runtime';
      // From here the server reports its own stages (weights, KV cache, warmup)
      // over `supervisor-event`; see subscribeToLoadProgress.
      const stopTrackingProgress = await this.subscribeToLoadProgress();
      try {
        await loadLocalModel(buildLocalModelRuntimeRequest({
          config,
          target: this.localModelLoadTarget,
          state: loadState
        }));
      } finally {
        stopTrackingProgress();
      }
      this.localModelLoadProgress = 96;
      this.localModelLoadPhase = 'Refreshing local model state';
      await modelsStore.refreshIndex();
      await modelsStore.refreshStatus();
      this.localModelLoadProgress = 100;
      this.localModelLoadPhase = 'Model ready';
      this.localModelActive = {
        name: this.localModelLoadTarget?.name || 'local model',
        path: this.localModelLoadTarget?.path || '',
        hasMmproj: !!(this.localModelLoadMmprojPath),
      };
      toastStore.success(`Model loaded: ${this.localModelLoadTarget?.name || 'local model'}`);
      if (isElectron()) {
        detectToolSupport().catch(() => {});
        // Forced: a fresh server just came up, so re-probe even when the
        // model identity is unchanged.
        this.refreshReasoningCapabilities(true).catch(() => {});
      }
      this.localModelLoadTarget = null;
    } finally {
      this.localModelLoading = false;
    }
  }

  async init() {
    this.ready = false;
    this.error = null;

    try {
      const CONFIG_TIMEOUT_SENTINEL = Symbol('timeout');
      const configResult = await withTimeout<AppConfig | typeof CONFIG_TIMEOUT_SENTINEL>(loadChatConfig(), 5000, CONFIG_TIMEOUT_SENTINEL);
      if (configResult === CONFIG_TIMEOUT_SENTINEL) {
        console.warn('[appStore.init] Config load timed out after 5s — using empty config fallback. Backend mode will default to local.');
        this.config = {};
      } else {
        this.config = configResult;
      }
      // In Electron: load from SQLite (primary). Falls back to localStorage migration.
      const dbResult = await loadChatStateFromDb();
      let chats: ChatSession[];
      let folders: ChatFolder[];
      let currentChatId: string | null;

      if (dbResult && dbResult.chats.length > 0) {
        chats = dbResult.chats;
        folders = dbResult.folders;
        // Restore currentChatId from localStorage (not stored in DB)
        const persisted = loadChatState<PersistedState>({ chats: [], folders: [], currentChatId: null });
        currentChatId = persisted.currentChatId;
        this.activeSpace = normalizeContextMode(persisted.activeSpace);
        this.currentChatIdBySpace = this.normalizeChatIdBySpace(persisted.currentChatIdBySpace);
      } else {
        const persisted = loadChatState<PersistedState>({ chats: [], folders: [], currentChatId: null });
        chats = Array.isArray(persisted.chats) ? persisted.chats : [];
        folders = Array.isArray(persisted.folders) ? persisted.folders : [];
        currentChatId = persisted.currentChatId;
        this.activeSpace = normalizeContextMode(persisted.activeSpace);
        this.currentChatIdBySpace = this.normalizeChatIdBySpace(persisted.currentChatIdBySpace);
      }

      this.chats = chats.map((chat, index) => repairRoleplayChat(normalizeChat(chat, index)));
      this.folders = folders.map((folder, index) => normalizeFolder(folder, index));
      this.currentChatId = currentChatId;

      if (!this.chats.length) {
        this.createChat(this.activeSpace);
      } else if (!this.currentChat) {
        // Stay in active space. Never fallback to chats[0] cross-space.
        this.currentChatId = this.resolveChatIdForSpace(this.activeSpace);
        if (!this.currentChatId) this.createChat(this.activeSpace);
      }
      this.activeSpace = normalizeContextMode(this.currentChat?.contextMode || this.activeSpace);
      this.rebuildChatIdBySpace();
      this.hydrateUiFromChat(this.currentChat);
    } catch (error) {
      this.error = toErrorMessage(error) || 'Failed to initialize application';
      if (!this.chats.length) {
        this.createChat(this.activeSpace);
      }
      console.error('[appStore.init] failed', error);
    } finally {
      this.ready = true;
    }

    void withTimeout(this.refreshModels(), 2500, undefined);
    if (isElectron()) {
      void detectToolSupport().catch(() => {});
      void this.refreshReasoningCapabilities().catch(() => {});
    }
    if (isElectron()) {
      void Promise.allSettled([
        withTimeout(modelsStore.refreshIndex(), 2500, undefined),
        withTimeout(modelsStore.refreshStatus(), 2500, undefined),
        withTimeout(downloadsStore.refresh(), 2500, undefined),
        withTimeout(this.refreshRagDocuments(), 2500, undefined)
      ]);
      void modelsStore.initPushEvents().then(() => {
        modelsStore.startPolling(3000);
      });
    }

    // Check first-run onboarding
    if (isElectron()) {
      void this.checkOnboarding();
    }
  }

  private async checkOnboarding() {
    try {
      const { checkIsFirstRun } = await import('$lib/services/onboarding');
      const isFirstRun = await checkIsFirstRun();
      if (isFirstRun) {
        this.onboardingOpen = true;
      }
      this.onboardingCompleted = !isFirstRun;
    } catch {
      // ignore — onboarding is optional
    }
  }

  /** Mark a chat (or current) dirty so SQLite flush includes it. */
  markChatDirty(chatId = this.currentChatId) {
    if (chatId) this.dirtyChatIds.add(chatId);
  }

  persist() {
    saveChatState<PersistedState>({
      chats: this.chats,
      folders: this.folders,
      currentChatId: this.currentChatId,
      activeSpace: this.activeSpace,
      currentChatIdBySpace: this.currentChatIdBySpace
    });
    // Flush current, generating, and any explicitly dirty chats to SQLite.
    const chatIds = new Set<string>(this.dirtyChatIds);
    if (this.currentChatId) chatIds.add(this.currentChatId);
    for (const chatId of Object.keys(this.activeRunsByChat)) {
      chatIds.add(chatId);
    }
    // Always mark current dirty so mode/workspace/draft changes survive restarts
    if (this.currentChatId) this.dirtyChatIds.add(this.currentChatId);

    for (const chatId of chatIds) {
      const chat = this.findChat(chatId);
      if (chat) {
        void saveChatStateToDb(chat);
        this.dirtyChatIds.delete(chatId);
      }
    }
  }

  private normalizeChatIdBySpace(value: unknown): Record<ChatContextMode, string | null> {
    const raw = value && typeof value === 'object' ? value as Partial<Record<string, unknown>> : {};
    return {
      // Legacy keys: 'chat' was the old home id; 'work'/'code' both named the
      // code space at different times.
      home: typeof raw.home === 'string' ? raw.home : (typeof raw.chat === 'string' ? raw.chat : null),
      code: typeof raw.code === 'string' ? raw.code : (typeof raw.work === 'string' ? raw.work : null),
      roleplay: typeof raw.roleplay === 'string' ? raw.roleplay : null
    };
  }

  private defaultTitleForMode(mode: ChatContextMode) {
    if (mode === 'code') return 'New session';
    if (mode === 'roleplay') return 'New roleplay';
    return 'New chat';
  }

  private isDefaultTitle(chat: ChatSession, title = chat.title) {
    return isDefaultChatTitle(title) || title === this.defaultTitleForMode(normalizeContextMode(chat.contextMode));
  }

  private defaultComposerModeFor(mode: ChatContextMode): 'chat' | 'instant' | 'agent' {
    return SPACES[mode].defaultComposerMode;
  }

  /** Load store UI mirrors from a session (per-chat isolation). */
  private hydrateUiFromChat(chat: ChatSession | null) {
    if (!chat) {
      this.composer = '';
      this.searchMode = 'chat';
      this.composerMode = 'chat';
      this.reasoningLevel = null;
      this.currentArtifact = null;
      this.currentArtifactMessageId = null;
      this.artifactStudioOpen = false;
      this.closeActivityDrawer();
      this.searchSidebarOpen = false;
      return;
    }
    const mode = normalizeContextMode(chat.contextMode);
    this.composer = chat.draft || '';
    this.searchMode = mode === 'roleplay' ? 'chat' : normalizeSessionSearchMode(chat.searchMode);
    this.composerMode = normalizeSessionComposerMode(chat.composerMode, mode);
    this.reasoningLevel = chat.reasoningLevel ?? null;
    // Keep session fields canonical after hydrate
    chat.searchMode = this.searchMode;
    chat.composerMode = this.composerMode;

    const lastArtifactMsg = findLatestArtifactMessage(chat);
    this.currentArtifact = lastArtifactMsg?.artifact || null;
    this.currentArtifactMessageId = lastArtifactMsg?.id || null;
    if (!this.currentArtifact) this.artifactStudioOpen = false;

    // Activity drawer only if message belongs to this chat
    if (this.activityDrawerOpen && this.activityMessageId) {
      const belongs = chat.messages.some((m) => m.id === this.activityMessageId);
      if (!belongs) this.closeActivityDrawer();
    }
    this.searchSidebarOpen = false;
  }

  private writeSearchModeToCurrentChat(mode: 'chat' | 'search' | 'deep' | 'max') {
    this.searchMode = mode;
    if (this.currentChat) {
      this.currentChat.searchMode = mode;
      this.touchChats();
    }
  }

  private writeComposerModeToCurrentChat(mode: 'chat' | 'instant' | 'agent') {
    this.composerMode = mode;
    if (this.currentChat) {
      this.currentChat.composerMode = mode;
      this.touchChats();
    }
  }

  private resolveChatIdForSpace(mode: ChatContextMode) {
    const remembered = this.currentChatIdBySpace[mode];
    if (remembered) {
      const chat = this.findChat(remembered);
      if (chat && normalizeContextMode(chat.contextMode) === mode) return remembered;
    }
    return this.chats.find((chat) => normalizeContextMode(chat.contextMode) === mode)?.id || null;
  }

  private rebuildChatIdBySpace() {
    const next: Record<ChatContextMode, string | null> = { home: null, code: null, roleplay: null };
    for (const chat of this.chats) {
      const mode = normalizeContextMode(chat.contextMode);
      if (!next[mode]) next[mode] = chat.id;
    }
    if (this.currentChat) {
      next[normalizeContextMode(this.currentChat.contextMode)] = this.currentChat.id;
    }
    this.currentChatIdBySpace = next;
  }

  setActiveSpace(mode: ChatContextMode) {
    const nextMode = normalizeContextMode(mode);
    if (this.currentChat) {
      const currentMode = normalizeContextMode(this.currentChat.contextMode);
      this.currentChatIdBySpace = { ...this.currentChatIdBySpace, [currentMode]: this.currentChat.id };
    }
    this.activeSpace = nextMode;
    const targetId = this.resolveChatIdForSpace(nextMode);
    if (targetId) {
      this.selectChat(targetId);
      return;
    }
    this.createChat(nextMode);
  }

  createChat(mode: ChatContextMode = this.activeSpace, options: { workspace?: ChatSession['workspace'] } = {}) {
    const contextMode = normalizeContextMode(mode);
    const now = Date.now();
    const composerMode = this.defaultComposerModeFor(contextMode);
    const chat: ChatSession = {
      id: createId('chat'),
      title: this.defaultTitleForMode(contextMode),
      createdAt: now,
      updatedAt: now,
      folderId: null,
      draft: '',
      contextMode,
      codeAgent: null,
      projectId: null,
      workspace: contextMode === 'code' ? (options.workspace || null) : null,
      reasoningLevel: null,
      composerMode,
      searchMode: 'chat',
      characterId: null,
      worldId: null,
      personaId: null,
      greetingIndex: 0,
      roleplay: contextMode === 'roleplay' ? {} : null,
      messages: []
    };
    this.chats = [chat, ...this.chats];
    this.activeSpace = contextMode;
    this.currentChatId = chat.id;
    this.currentChatIdBySpace = { ...this.currentChatIdBySpace, [contextMode]: chat.id };
    this.refreshGenerationState();
    for (const attachment of this.pendingAttachments) {
      if (attachment.preview?.startsWith('blob:')) URL.revokeObjectURL(attachment.preview);
    }
    this.pendingAttachments = [];
    this.hydrateUiFromChat(chat);
    this.persist();
    return chat;
  }

  /**
   * Group scenes: who speaks next. Transient (never persisted) and defaults to
   * the primary character, so 1:1 chats are unaffected.
   */
  private roleplaySpeakerOverrides: Record<string, string> = {};

  /** Auto mode: consecutive character turns and the pending continuation. */
  private roleplayAutoTurns: Record<string, number> = {};
  private roleplayAutoTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  /** Wall-clock deadline of the pending auto turn, for the header countdown. */
  roleplayAutoDeadlines = $state<Record<string, number>>({});

  /** The character whose turn it is in a scene. */
  private roleplaySpeakerId(chat: ChatSession | null): string | null {
    if (!chat) return null;
    return this.roleplaySpeakerOverrides[chat.id] || chat.characterId || null;
  }

  /** Force the next speaker in a group scene (null resets to turn order). */
  setRoleplaySpeaker(characterId: string | null) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    if (!characterId || characterId === chat.characterId) {
      delete this.roleplaySpeakerOverrides[chat.id];
    } else {
      this.roleplaySpeakerOverrides[chat.id] = characterId;
    }
  }

  /** The scene's cast in roster order. */
  private roleplayCast(chat: ChatSession | null): CharacterCard[] {
    if (!chat) return [];
    const ids = chat.roleplay?.characterIds?.length
      ? chat.roleplay.characterIds
      : chat.characterId
        ? [chat.characterId]
        : [];
    return ids
      .map((id) => charactersStore.getById(id))
      .filter((card): card is CharacterCard => !!card);
  }

  /**
   * Who speaks next: a forced speaker wins, otherwise the scene's reply order
   * decides. 1:1 scenes always answer as the character; manual order answers
   * as the primary on a plain send (the user force-talks for anyone else).
   */
  private routeRoleplaySpeaker(chat: ChatSession, messages: ChatMessage[] = chat.messages): string | null {
    const cast = this.roleplayCast(chat);
    if (cast.length < 2) return chat.characterId || null;
    const forced = this.roleplaySpeakerOverrides[chat.id];
    if (forced) return forced;
    const strategy = chat.roleplay?.replyOrder || 'list';
    if (strategy === 'manual') return chat.characterId || null;
    return selectNextSpeaker({
      strategy,
      cast,
      messages,
      mutedIds: chat.roleplay?.mutedIds || [],
      allowSelfReplies: false
    });
  }

  /** Replace the scene's cast mid-chat (add, remove, reorder). */
  setRoleplayCast(characterIds: string[]) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    const cast = [...new Set(characterIds)].filter((id) => !!charactersStore.getById(id));
    if (!cast.length) return;
    const muted = (chat.roleplay?.mutedIds || []).filter((id) => cast.includes(id));
    chat.roleplay = { ...(chat.roleplay || {}), characterIds: cast, mutedIds: muted };
    // The primary must be a member; removing it promotes the new first member.
    if (!chat.characterId || !cast.includes(chat.characterId)) {
      chat.characterId = cast[0];
    }
    delete this.roleplaySpeakerOverrides[chat.id];
    this.touchChats();
    this.persist();
  }

  /** Who the roster should show as next, without forcing a turn. */
  peekRoleplaySpeaker(): CharacterCard | null {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return null;
    return charactersStore.getById(this.routeRoleplaySpeaker(chat));
  }

  /**
   * Generate a character turn with no user message (force talk, auto mode).
   */
  async speakNow(characterId?: string | null) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    if (characterId) this.setRoleplaySpeaker(characterId);
    await this.sendCurrentMessage({ silent: true });
  }

  /** Enable or pause auto mode for the current scene. */
  setRoleplayAutoMode(enabled: boolean) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    if (enabled && (chat.roleplay?.replyOrder || 'list') === 'manual') {
      toastStore.info('Auto mode needs a speaker order. Switch off Manual first.', 4000);
      return;
    }
    chat.roleplay = { ...(chat.roleplay || {}), autoMode: enabled };
    if (enabled) {
      this.roleplayAutoTurns[chat.id] = 0;
      this.touchChats();
      this.persist();
      void this.speakNow();
    } else {
      this.stopRoleplayAuto(chat.id);
      this.touchChats();
      this.persist();
    }
  }

  /** Mute or unmute a group member for this scene. */
  toggleRoleplayMute(characterId: string) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    const muted = new Set(chat.roleplay?.mutedIds || []);
    if (muted.has(characterId)) muted.delete(characterId);
    else muted.add(characterId);
    chat.roleplay = { ...(chat.roleplay || {}), mutedIds: [...muted] };
    this.touchChats();
    this.persist();
  }

  /** Change the scene's speaker order. */
  setRoleplayReplyOrder(order: RoleplaySettings['replyOrder']) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay' || !order) return;
    chat.roleplay = { ...(chat.roleplay || {}), replyOrder: order };
    this.touchChats();
    this.persist();
  }

  /** Scene settings: one option at a time (order, delay, toggles). */
  setRoleplayOption<K extends keyof RoleplaySettings>(key: K, value: RoleplaySettings[K]) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    chat.roleplay = { ...(chat.roleplay || {}), [key]: value } as RoleplaySettings;
    this.touchChats();
    this.persist();
  }

  /** Adventure choices: clicking one sends it as the user's turn. */
  async sendAdventureChoice(choice: string) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    const text = String(choice || '').trim();
    if (!text) return;
    this.composer = text;
    await this.sendCurrentMessage();
  }

  // ── Story turns and the scene journal ──────────────────────────────────

  /**
   * A turn the user did not write, queued for the next generation: a thrown
   * twist, or the silence of a choice that ran out with nothing said.
   */
  private roleplayPendingStoryTurn: Record<string, StoryTurn> = {};

  private queueRoleplayStoryTurn(chatId: string, turn: StoryTurn) {
    this.roleplayPendingStoryTurn = { ...this.roleplayPendingStoryTurn, [chatId]: turn };
  }

  private takeRoleplayStoryTurn(chatId: string): StoryTurn | undefined {
    const turn = this.roleplayPendingStoryTurn[chatId];
    if (!turn) return undefined;
    const next = { ...this.roleplayPendingStoryTurn };
    delete next[chatId];
    this.roleplayPendingStoryTurn = next;
    return turn;
  }

  /** Throw a story twist at the scene: a GM move, never a user turn. */
  async throwRoleplayTwist() {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    if (this.currentChatGenerating) return;
    this.queueRoleplayStoryTurn(chat.id, makeTwistTurn(pickTwist(), this.roleplayNames(chat)));
    await this.speakNow();
  }

  /**
   * A clocked choice ran out with nothing said. Saying nothing is the turn —
   * never a random pick from the panel.
   */
  async expireRoleplayChoice() {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    if (this.currentChatGenerating) return;
    this.queueRoleplayStoryTurn(chat.id, makeSilenceTurn(this.roleplayNames(chat)));
    await this.speakNow();
  }

  /** Scene journal: keep something — a prop, a note, a lead, a bond. */
  addRoleplayJournalEntry(entry: {
    kind: RoleplayJournalEntry['kind'];
    title: string;
    body: string;
    messageId?: string | null;
    pinned?: boolean;
  }) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    const journal = [...(chat.roleplay?.journal || [])];
    const messageId = entry.messageId ?? null;
    // Re-keeping from the viewer must not duplicate the entry.
    const duplicate = journal.some(
      (item) => item.kind === entry.kind && item.title === entry.title && (item.messageId ?? null) === messageId
    );
    if (duplicate) return;

    journal.push({
      id: createId('journal'),
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      pinned: !!entry.pinned,
      messageId,
      createdAt: Date.now()
    });
    // The journal rides on the chat's roleplay JSON, so it stays bounded.
    const MAX_ENTRIES = 200;
    chat.roleplay = { ...(chat.roleplay || {}), journal: journal.slice(-MAX_ENTRIES) };
    this.touchChats();
    this.persist();
  }

  removeRoleplayJournalEntry(entryId: string) {
    this.patchRoleplayJournal((journal) => journal.filter((entry) => entry.id !== entryId));
  }

  pinRoleplayJournalEntry(entryId: string, pinned: boolean) {
    this.patchRoleplayJournal((journal) =>
      journal.map((entry) => (entry.id === entryId ? { ...entry, pinned } : entry))
    );
  }

  private patchRoleplayJournal(patch: (journal: RoleplayJournalEntry[]) => RoleplayJournalEntry[]) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    chat.roleplay = { ...(chat.roleplay || {}), journal: patch(chat.roleplay?.journal || []) };
    this.touchChats();
    this.persist();
  }

  private clearRoleplayAutoTimer(chatId: string) {
    const timer = this.roleplayAutoTimers[chatId];
    if (timer) {
      clearTimeout(timer);
      delete this.roleplayAutoTimers[chatId];
    }
    this.clearRoleplayAutoDeadline(chatId);
  }

  private clearRoleplayAutoDeadline(chatId: string) {
    if (!(chatId in this.roleplayAutoDeadlines)) return;
    const next = { ...this.roleplayAutoDeadlines };
    delete next[chatId];
    this.roleplayAutoDeadlines = next;
  }

  /** Typing pauses the auto chain without turning auto mode off. */
  pauseRoleplayAuto() {
    const chat = this.currentChat;
    if (!chat) return;
    this.clearRoleplayAutoTimer(chat.id);
    this.roleplayAutoTurns[chat.id] = 0;
  }

  /** Stop auto mode for a scene and forget its turn count. */
  private stopRoleplayAuto(chatId: string) {
    this.clearRoleplayAutoTimer(chatId);
    delete this.roleplayAutoTurns[chatId];
  }

  /** A user turn resets the chain; auto mode itself stays enabled. */
  private resetRoleplayAuto(chatId: string) {
    this.clearRoleplayAutoTimer(chatId);
    this.roleplayAutoTurns[chatId] = 0;
  }

  /**
   * After a completed turn: keep a group scene going while auto mode is on,
   * the limit is not reached, and the user is not typing. A failed or aborted
   * turn stops the chain instead of looping.
   */
  private maybeContinueRoleplayAuto(chatId: string, stopped = false) {
    const chat = this.findChat(chatId);
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return;
    const settings = chat.roleplay;
    const castCount = settings?.characterIds?.length || 0;
    if (
      stopped
      || !settings?.autoMode
      || castCount < 2
      || (settings.replyOrder || 'list') === 'manual'
    ) {
      this.stopRoleplayAuto(chatId);
      return;
    }
    const turns = (this.roleplayAutoTurns[chatId] || 0) + 1;
    const limit = settings.autoModeMaxTurns ?? 4;
    if (turns > limit) {
      this.roleplayAutoTurns[chatId] = 0;
      toastStore.info(`Auto mode paused after ${limit} turns.`, 4000);
      return;
    }
    this.roleplayAutoTurns[chatId] = turns;
    this.clearRoleplayAutoTimer(chatId);
    const delay = Math.min(20_000, Math.max(1_000, Number(settings.autoModeDelayMs) || 8000));
    this.roleplayAutoDeadlines = { ...this.roleplayAutoDeadlines, [chatId]: Date.now() + delay };
    this.roleplayAutoTimers[chatId] = setTimeout(() => {
      delete this.roleplayAutoTimers[chatId];
      this.clearRoleplayAutoDeadline(chatId);
      // Typing interrupts the chain; so does another run taking the chat.
      if (this.currentChatId !== chatId || this.composer.trim() || this.currentChatGenerating) return;
      void this.speakNow();
    }, delay);
  }

  /** Speaker attribution for the request pipeline (group scenes only). */
  private buildRoleplayAttribution(chat: ChatSession | null, speakerId?: string | null): RoleplayAttribution | undefined {
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return undefined;
    const ids = chat.roleplay?.characterIds?.length
      ? chat.roleplay.characterIds
      : chat.characterId
        ? [chat.characterId]
        : [];
    const names = new Map<string, string>();
    for (const id of ids) {
      const card = charactersStore.getById(id);
      if (card?.name) names.set(id, card.name);
    }
    const speaker = charactersStore.getById(speakerId ?? this.roleplaySpeakerId(chat));
    return {
      names,
      userName: charactersStore.getPersonaById(chat.personaId)?.name || this.userName || 'User',
      group: ids.length > 1,
      speakerName: speaker?.name
    };
  }

  /**
   * Replies mimic the `Name:` attribution we send for group scenes. Strip it
   * at ingest unless the scene explicitly wants speaker labels.
   */
  private buildRoleplayOutputSanitizer(chat: ChatSession | null): ((content: string) => string) | undefined {
    if (!chat || normalizeContextMode(chat.contextMode) !== 'roleplay') return undefined;
    const labels = !!chat.roleplay?.showSpeakerLabels || !!chat.roleplay?.allowMultiSpeaker;
    const hideChoices = !!chat.roleplay?.adventureChoices;

    const names = new Set<string>();
    if (!labels) {
      for (const card of this.roleplayCast(chat)) {
        if (card.name) names.add(card.name);
        if (card.nickname) names.add(card.nickname);
      }
      const persona = charactersStore.getPersonaById(chat.personaId) ?? charactersStore.defaultPersona;
      if (persona?.name) names.add(persona.name);
    }
    // Nothing to clean: no prefixes to strip and no choices block to lift.
    if (!hideChoices && !names.size) return undefined;

    return (content: string) => {
      const visible = hideChoices ? stripRoleplayChoiceBlock(content) : content;
      return names.size ? stripSpeakerPrefix(visible, names) : visible;
    };
  }

  /**
   * Start a roleplay scene.
   *
   * A scene is a roleplay chat bound to a cast (the first card is the primary
   * speaker) and optionally to a world. It is seeded with an opening turn:
   * either the world's chosen starter (narrator) or the primary's greeting.
   */
  startScene(options: {
    characters: CharacterCard[];
    world?: RoleplayWorld | null;
    personaId?: string | null;
    openingSource?: 'greeting' | 'starter' | 'none';
    openingIndex?: number;
    settings?: Partial<RoleplaySettings>;
  }) {
    const cast = options.characters.filter(Boolean);
    const primary = cast[0];
    if (!primary) return this.currentChat;

    // Picking a scene from the library must not leave the empty "New roleplay"
    // chat behind: bind the current empty roleplay chat instead.
    const current = this.currentChat;
    const reusable = !!current
      && normalizeContextMode(current.contextMode) === 'roleplay'
      && !current.characterId
      && current.messages.length === 0;
    const created = reusable ? current : this.createChat('roleplay');
    // createChat returns the raw object; `$state` holds a proxy. Identity and
    // greeting fields must be written through the state view or they never
    // reach the send path (and never persist).
    const chat = this.findChat(created.id) || created;
    const world = options.world || null;
    const group = cast.length > 1;
    const openingSource = options.openingSource || 'greeting';
    const openings = openingSource === 'starter'
      ? (world?.starters || []).filter((entry) => entry.trim())
      : openingSource === 'greeting'
        ? greetingsFor(primary, { group })
        : [];
    const openingIndex = openings.length
      ? Math.max(0, Math.min(options.openingIndex ?? 0, openings.length - 1))
      : 0;
    const worldSettings = world?.settings || {};

    chat.characterId = primary.id;
    chat.worldId = world?.id ?? null;
    chat.personaId = options.personaId ?? null;
    chat.greetingIndex = openingIndex;
    chat.roleplay = {
      characterIds: cast.map((card) => card.id),
      replyOrder: worldSettings.replyOrder ?? 'list',
      autoMode: worldSettings.autoMode ?? false,
      autoModeMaxTurns: worldSettings.autoModeMaxTurns ?? 4,
      autoModeDelayMs: worldSettings.autoModeDelayMs ?? 8000,
      adventureChoices: worldSettings.adventureChoices ?? false,
      showSpeakerLabels: worldSettings.showSpeakerLabels ?? false,
      allowMultiSpeaker: worldSettings.allowMultiSpeaker ?? false,
      temperature: worldSettings.temperature ?? null,
      topP: worldSettings.topP ?? null,
      maxTokens: worldSettings.maxTokens ?? null,
      authorNote: worldSettings.authorNote ?? '',
      contentRating: worldSettings.contentRating ?? 'sfw',
      mutedIds: [],
      ...(options.settings || {})
    };
    chat.title = world?.name || (group ? `${primary.name} +${cast.length - 1}` : primary.name) || chat.title;

    const opening = openings[openingIndex];
    if (opening) {
      this.appendMessageToChat(chat.id, {
        id: createId('msg'),
        role: 'assistant',
        content: opening,
        createdAt: Date.now(),
        done: true,
        status: 'idle',
        // A world starter is narration, not the primary's line.
        model: openingSource === 'starter' ? undefined : primary.name || undefined,
        speakerId: openingSource === 'starter' ? null : primary.id,
        versions: [],
        activeVersion: 0,
        mode: 'chat'
      });
    }

    this.touchChats();
    this.persist();
    return chat;
  }

  /**
   * Start a 1:1 scene with one character: the quick path from the gallery.
   */
  startRoleplay(character: CharacterCard, options: { personaId?: string | null; greetingIndex?: number } = {}) {
    return this.startScene({
      characters: [character],
      personaId: options.personaId ?? null,
      openingSource: 'greeting',
      openingIndex: options.greetingIndex ?? 0
    }) as ChatSession;
  }

  /** Replace the opening turn with another greeting from the same character. */
  setRoleplayGreeting(character: CharacterCard, index: number) {
    const chat = this.currentChat;
    if (!chat || chat.contextMode !== 'roleplay') return;
    const group = (chat.roleplay?.characterIds?.length || 0) > 1;
    const greetings = greetingsFor(character, { group });
    const greeting = greetings[index];
    if (!greeting) return;

    chat.greetingIndex = index;
    const first = chat.messages[0];
    if (first && first.role === 'assistant') {
      first.content = greeting;
      first.speakerId = character.id;
    } else {
      chat.messages.unshift({
        id: createId('msg'),
        role: 'assistant',
        content: greeting,
        createdAt: Date.now(),
        done: true,
        status: 'idle',
        model: character.name || undefined,
        speakerId: character.id,
        versions: [],
        activeVersion: 0,
        mode: 'chat'
      });
    }
    this.touchChats();
    this.persist();
  }

  /** Bind the current roleplay chat to a user persona (null = none). */
  setRoleplayPersona(personaId: string | null) {
    const chat = this.currentChat;
    if (!chat || chat.contextMode !== 'roleplay') return;
    chat.personaId = personaId;
    this.touchChats();
    this.persist();
  }

  selectChat(chatId: string) {
    const match = this.chats.find((chat) => chat.id === chatId);
    if (!match) return;
    const mode = normalizeContextMode(match.contextMode);
    this.activeSpace = mode;
    this.currentChatIdBySpace = { ...this.currentChatIdBySpace, [mode]: chatId };

    for (const attachment of this.pendingAttachments) {
      if (attachment.preview?.startsWith('blob:')) {
        URL.revokeObjectURL(attachment.preview);
      }
    }
    this.pendingAttachments = [];

    this.currentChatId = chatId;
    this.refreshGenerationState();
    // Restore per-chat UI slice (modes, draft, panels) — never rewrite contextMode
    this.hydrateUiFromChat(match);
    this.persist();
    if (isElectron()) {
      void this.refreshRagDocuments(chatId);
    }
  }

  updateComposer(value: string) {
    this.composer = value;
    if (this.currentChat) {
      this.currentChat.draft = value;
      this.persist();
    }
  }

  setUserName(name: string) {
    this.userName = name;
    try { localStorage.setItem(USER_NAME_KEY, name); } catch {}
  }

  /**
   * Per-chat caches owned by feature stores (e.g. the Code run map) register
   * teardown here. Keeping the hook on AppStore makes `deleteChat` the single
   * deletion choke point without AppStore importing feature stores, which
   * would create an import cycle through the stores they depend on.
   */
  readonly chatDeletedHooks = new Set<(chatId: string) => void>();

  /** Register per-chat cache teardown. Returns an unregister function. */
  onChatDeleted(hook: (chatId: string) => void): () => void {
    this.chatDeletedHooks.add(hook);
    return () => this.chatDeletedHooks.delete(hook);
  }

  deleteChat(chatId: string) {
    if (this.isChatGenerating(chatId)) {
      this.stopStreaming(chatId);
    }
    const title = this.chats.find((c) => c.id === chatId)?.title;
    const deletedMode = normalizeContextMode(this.chats.find((c) => c.id === chatId)?.contextMode || this.activeSpace);
    this.chats = this.chats.filter((chat) => chat.id !== chatId);
    for (const hook of this.chatDeletedHooks) {
      // A feature cache failing to tear down must never block the deletion.
      try { hook(chatId); } catch { /* ignore */ }
    }
    const activeRuns = { ...this.activeRunsByChat };
    delete activeRuns[chatId];
    this.activeRunsByChat = activeRuns;
    this.refreshGenerationState();
    delete this.ragDocumentsByChat[chatId];
    const searchStates = { ...this.searchStateByChat };
    delete searchStates[chatId];
    this.searchStateByChat = searchStates;
    if (this.currentChatId === chatId) {
      // Stay in deleted space. Never fallback to chats[0] cross-space:
      // deleting last home chat jumped to code section.
      this.activeSpace = deletedMode;
      const nextId = this.resolveChatIdForSpace(deletedMode);
      if (nextId) {
        this.currentChatId = nextId;
        this.hydrateUiFromChat(this.currentChat);
      } else {
        this.currentChatId = null;
      }
    }
    this.rebuildChatIdBySpace();
    if (!this.currentChatId || !this.currentChat) {
      this.activeSpace = this.currentChat ? normalizeContextMode(this.currentChat.contextMode) : deletedMode;
      if (!this.currentChat) this.createChat(this.activeSpace);
    }
    if (!this.chats.length) this.createChat(this.activeSpace);
    this.persist();
    if (isElectron()) {
      clearRagDocuments(chatId).catch(() => {});
    }
    deleteChatFromDb(chatId).catch(() => {});
    toastStore.info(`Chat deleted${title ? `: ${title}` : ''}`, 2500);
  }

  renameChat(chatId: string, title: string) {
    const chat = this.chats.find((c) => c.id === chatId);
    if (!chat) return;
    chat.title = title.trim() || this.defaultTitleForMode(normalizeContextMode(chat.contextMode));
    this.touchChats();
    this.persist();
  }

  openEditMessage(messageId: string) {
    const message = this.currentChat?.messages.find((entry) => entry.id === messageId);
    if (!message) return;
    this.editingMessageId = messageId;
    this.editingMessageContent = getMessageRequestContent(message);
  }

  closeEditMessage() {
    this.editingMessageId = null;
    this.editingMessageContent = '';
  }

  updateEditingMessage(value: string) {
    this.editingMessageContent = value;
  }

  saveEditedMessage() {
    const chat = this.currentChat;
    const messageId = this.editingMessageId;
    const nextContent = this.editingMessageContent.trim();
    if (!chat || !messageId || !nextContent) {
      this.closeEditMessage();
      return;
    }

    const index = chat.messages.findIndex((entry) => entry.id === messageId);
    if (index < 0) {
      this.closeEditMessage();
      return;
    }

    const message = chat.messages[index];
    if (message.role === 'user') {
      message.content = nextContent;
      chat.messages = chat.messages.slice(0, index + 1);
    } else {
      if (!Array.isArray(message.versions) || !message.versions.length) {
        message.versions = [{
          content: nextContent,
          reasoning: message.reasoning || '',
          createdAt: Date.now(),
          metadata: message.metadata
        }];
        message.activeVersion = 0;
      } else {
        const activeIndex = typeof message.activeVersion === 'number'
          ? Math.max(0, Math.min(message.activeVersion, message.versions.length - 1))
          : 0;
        message.versions[activeIndex] = {
          ...message.versions[activeIndex],
          content: nextContent
        };
        message.activeVersion = activeIndex;
      }
      message.content = nextContent;
    }

    chat.updatedAt = Date.now();
    this.closeEditMessage();
    this.touchChats();
    this.persist();
  }

  deleteMessage(messageId: string) {
    const chat = this.currentChat;
    if (!chat) return;
    const index = chat.messages.findIndex((entry) => entry.id === messageId);
    if (index < 0) return;
    chat.messages = chat.messages.filter((entry) => entry.id !== messageId);
    chat.updatedAt = Date.now();
    if (this.editingMessageId === messageId) {
      this.closeEditMessage();
    }
    this.touchChats();
    this.persist();
  }

  private appendMessage(message: ChatMessage) {
    return this.appendMessageToChat(this.currentChatId || '', message);
  }

  private appendMessageToChat(chatId: string, message: ChatMessage) {
    const chat = this.findChat(chatId);
    if (!chat) return null;
    chat.messages = [...chat.messages, message];
    chat.updatedAt = Date.now();

    // Fast provisional title so history updates instantly.
    if (this.isDefaultTitle(chat) && message.role === 'user') {
      const firstUser = chat.messages.find((m) => m.role === 'user');
      const preview = (firstUser?.content || '').trim().replace(/\s+/g, ' ').slice(0, 48);
      if (preview) chat.title = preview;
    }

    this.touchChats(); // notify reactive subscribers of array mutation
    this.persist();
    return message;
  }

  touchChats(chatId = this.currentChatId) {
    if (chatId) this.dirtyChatIds.add(chatId);
    this.chats = [...this.chats];
  }

  private findChat(chatId: string | null | undefined) {
    if (!chatId) return null;
    return this.chats.find((chat) => chat.id === chatId) || null;
  }

  private buildSearchConversationContext(currentUserMessageId?: string, chatId = this.currentChatId || '') {
    return buildSearchConversationContext(this.findChat(chatId), currentUserMessageId);
  }

  private buildContextualPrompt(args: Parameters<typeof buildContextualPromptHelper>[0]) {
    return buildContextualPromptHelper(args);
  }

  /**
   * @deprecated Space identity is immutable on a session.
   * Use setActiveSpace() / createChat(mode) instead of converting a chat.
   * Kept as a no-op switch to the target space for any residual callers.
   */
  setContextMode(mode: ChatContextMode) {
    const nextMode = normalizeContextMode(mode);
    if (this.currentChat && normalizeContextMode(this.currentChat.contextMode) === nextMode) {
      return;
    }
    this.setActiveSpace(nextMode);
  }

  setSearchMode(mode: 'chat' | 'search' | 'deep' | 'max') {
    const next = this.searchMode === mode ? 'chat' : mode;
    this.writeSearchModeToCurrentChat(next);
    this.persist();
  }

  setReasoningLevel(level: ReasoningLevel | null) {
    this.reasoningLevel = level;
    const chat = this.currentChat;
    if (chat) {
      chat.reasoningLevel = level;
      this.touchChats();
      this.persist();
    }
  }

  /** Route identity the reasoning capabilities were last probed for. */
  private reasoningCapabilitiesKey = '';
  /** Monotonic guard so a slow probe cannot overwrite a newer route's result. */
  private reasoningCapabilitiesSeq = 0;

  async refreshReasoningCapabilities(force = false) {
    if (!isElectron()) {
      this.reasoningCapabilities = { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' };
      return;
    }
    const seq = ++this.reasoningCapabilitiesSeq;
    try {
      const config = await loadChatConfig();
      if (seq !== this.reasoningCapabilitiesSeq) return; // superseded while loading
      const identity = reasoningRouteIdentity(config);
      if (!force && identity === this.reasoningCapabilitiesKey && this.reasoningCapabilities.source !== 'unknown') {
        return; // already probed for this exact route — skip probe spam
      }
      const backendMode = config.llm?.backend_mode || (isElectron() ? 'local' : 'api');
      let capabilities: ReasoningCapabilities;
      if (backendMode === 'local') {
        const local = config.llm?.local || {};
        capabilities = await fetchReasoningCapabilities({
          providerName: 'local',
          model: local.model || 'local-model',
          modelPath: local.selected_model_path || ''
        });
      } else {
        const providerName = config.llm?.provider || 'openai';
        const provider = (config.llm?.providers?.[providerName] || {}) as { base_url?: string; api_key?: string; model?: string };
        capabilities = await fetchReasoningCapabilities({
          baseUrl: provider.base_url,
          apiKey: provider.api_key,
          providerName,
          model: provider.model || ''
        });
      }
      if (seq !== this.reasoningCapabilitiesSeq) return; // stale response — a newer refresh won
      this.reasoningCapabilitiesKey = identity;
      this.reasoningCapabilities = capabilities;
      // The level resets only on a successful probe that excludes it. A
      // failed probe keeps the previous capabilities and level — transient
      // failures must not wipe the user's choice.
      if (this.reasoningCapabilities.supported && this.reasoningLevel &&
          !this.reasoningCapabilities.levels.includes(this.reasoningLevel)) {
        this.setReasoningLevel(null);
      }
      if (!this.reasoningCapabilities.supported) {
        this.setReasoningLevel(null);
      }
    } catch {
      if (seq !== this.reasoningCapabilitiesSeq) return;
      // Keep previous capabilities and level on transient failure.
    }
  }

  async performWebSearch(query: string, chatId = this.currentChatId || '') {
    const trimmed = String(query || '').trim();
    const targetChatId = chatId || '';
    if (!targetChatId) return;
    if (!trimmed) {
      this.setSearchStateForChat(targetChatId, { results: [], query: '', loading: false });
      return;
    }

    this.setSearchStateForChat(targetChatId, { loading: true, query: trimmed });
    try {
      const response = await webSearch({
        query: trimmed,
        context: this.buildSearchConversationContext(undefined, targetChatId),
        deep: false,
        mode: 'search'
      });
      this.setSearchStateForChat(targetChatId, {
        results: Array.isArray(response.results) ? response.results : [],
        loading: false,
        query: trimmed
      });
    } catch (error) {
      this.setSearchStateForChat(targetChatId, { results: [], loading: false, query: trimmed });
      toastStore.error(toErrorMessage(error) || 'Search failed');
    }
  }

  openSearchSidebarWithResults(results: SearchResult[], chatId = this.currentChatId || '') {
    if (chatId) {
      this.setSearchStateForChat(chatId, {
        results: Array.isArray(results) ? results : [],
        loading: false
      });
    }
    this.searchSidebarOpen = true;
  }

  setComposerMode(mode: 'instant' | 'agent') {
    if (mode === 'agent' || mode === 'instant') {
      this.writeSearchModeToCurrentChat('chat');
    }
    // Work/Code default to agent but user can still switch; value is per-chat.
    this.writeComposerModeToCurrentChat(mode);
    this.persist();
  }

  async refreshRagDocuments(chatId = this.currentChatId || '') {
    if (!isElectron() || !chatId) return;
    try {
      const docs = await listRagDocuments(chatId);
      this.ragDocumentsByChat = {
        ...this.ragDocumentsByChat,
        [chatId]: docs
      };
    } catch {
      this.ragDocumentsByChat = {
        ...this.ragDocumentsByChat,
        [chatId]: []
      };
    }
  }

  async clearRag() {
    const targetChatId = this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    if (!isElectron() || !targetChatId || !targetChat) return;
    await clearRagDocuments(targetChatId);
    this.pendingAttachments = [];
    // Clear workspace files but never demote Work → Chat
    if (targetChat.workspace && normalizeContextMode(targetChat.contextMode) === 'code') {
      targetChat.workspace = null;
      this.touchChats();
      this.persist();
    }
    await this.refreshRagDocuments(targetChatId);
  }

  removeAttachment(attachmentId: string) {
    const attachment = this.pendingAttachments.find((a) => a.id === attachmentId);
    this.pendingAttachments = this.pendingAttachments.filter((a) => a.id !== attachmentId);
    // If image, revoke the blob URL to free memory
    if (attachment?.preview?.startsWith('blob:')) {
      URL.revokeObjectURL(attachment.preview);
    }
    // If it's a RAG document, remove from backend too
    if (attachment?.docId && isElectron() && this.currentChatId) {
      removeRagDocument(attachment.docId, this.currentChatId).catch(() => {});
      this.refreshRagDocuments().catch(() => {});
    }
  }

  async removeRagDoc(docId: string) {
    if (!isElectron() || !this.currentChatId) return;
    await removeRagDocument(docId, this.currentChatId);
    this.pendingAttachments = this.pendingAttachments.filter((attachment) => attachment.docId !== docId);
    if (this.currentChat?.workspace) {
      const nextFiles = this.currentChat.workspace.files.filter((file) => file.docId !== docId);
      if (nextFiles.length !== this.currentChat.workspace.files.length) {
        this.currentChat.workspace = nextFiles.length
          ? recalculateWorkspace({
              ...this.currentChat.workspace,
              files: nextFiles
            })
          : null;
        // Keep contextMode; empty workspace does not convert Work → Chat
        this.touchChats();
        this.persist();
      }
    }
    await this.refreshRagDocuments();
  }

  async addFiles(files: File[]) {
    const targetChatId = this.currentChatId;
    if (!files.length || !targetChatId) return;

    const nextAttachments: Attachment[] = [];

    for (const file of files) {
      const attachment: Attachment = {
        id: createId('attachment'),
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        kind: file.type.startsWith('image/') && !/\.pdf$/i.test(file.name) ? 'image' : 'document',
        status: 'processing'
      };

      if (attachment.kind === 'image') {
        attachment.preview = URL.createObjectURL(file);
        // Read base64 for vision API calls.
        attachment.base64 = await readBlobAsDataUrl(file);
        const visionReady = await hasConfiguredVisionModel(this.config);
        attachment.visionReady = visionReady;
        attachment.processingMode = visionReady ? 'vision' : 'ocr';

        if (!visionReady) {
          try {
            const { extractTextFromFile } = await import('$lib/services/ocr');
            const ocrText = await extractTextFromFile(file);
            if (ocrText.trim()) attachment.ocrText = ocrText.trim();
          } catch (err: unknown) {
            console.warn('[addFiles] OCR failed for image:', err);
          }
        }
        attachment.status = 'ready';
        nextAttachments.push(attachment);
        continue;
      }

      // Create blob URL for document preview
      const fileBuffer = await file.arrayBuffer();
      const fileBlob = new Blob([fileBuffer], { type: file.type });
      attachment.data = await readBlobAsDataUrl(fileBlob);
      attachment.size = fileBlob.size;
      attachment.processingMode = 'document_text';

      // Documents: try backend RAG ingestion, fallback to client-side extraction
      try {
        const bytes = new Uint8Array(fileBuffer);
        const tempPath = await writeTempFile(`${Date.now()}_${file.name}`, bytes);
        const doc = await ingestDocument({
          file_path: tempPath,
          chat_id: targetChatId
        });
        attachment.docId = doc.id;
        attachment.status = 'ready';
        nextAttachments.push(attachment);
      } catch (error) {
        // Backend RAG failed — try client-side text extraction (OCR/PDF.js)
        console.warn('[addFiles] Backend ingest failed, trying client-side extraction:', error);

        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        const errorMessage = toErrorMessage(error) || 'Failed to process file';
        const parserFailed = isPdf && /could not parse pdf text|pdf parser returned insufficient readable text/i.test(errorMessage);

        if (parserFailed) {
          attachment.status = 'error';
          attachment.error = 'PDF parser could not extract readable text. Please upload a text-based PDF export.';
          nextAttachments.push(attachment);
          continue;
        }

        try {
          const { extractTextFromFile } = await import('$lib/services/ocr');
          const text = await extractTextFromFile(file);
          if (text.trim()) {
            attachment.ocrText = text.trim();
            attachment.status = 'ready';
          } else {
            attachment.status = 'error';
            attachment.error = 'Could not extract text from file';
          }
        } catch (ocrErr) {
          attachment.status = 'error';
          attachment.error = toErrorMessage(error) || 'Failed to process file';
        }
        nextAttachments.push(attachment);
      }
    }

    if (this.currentChatId === targetChatId) {
      this.pendingAttachments = [...this.pendingAttachments, ...nextAttachments];
    } else {
      for (const attachment of nextAttachments) {
        if (attachment.preview?.startsWith('blob:')) URL.revokeObjectURL(attachment.preview);
      }
    }
    await this.refreshRagDocuments(targetChatId);
  }

  private async clearWorkspaceDocs(chatId = this.currentChatId || '') {
    const chat = this.findChat(chatId);
    if (!chatId || !chat?.workspace?.files?.length) return;
    await Promise.allSettled(
      chat.workspace.files
        .map((file) => file.docId)
        .filter((docId): docId is string => !!docId)
        .map((docId) => removeRagDocument(docId, chatId))
    );
  }

  async pickWorkspaceFolder() {
    const targetChatId = this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    if (!isElectron() || !targetChatId || !targetChat) return;
    if (normalizeContextMode(targetChat.contextMode) !== 'code') {
      toastStore.info('Switch to the Code tab to attach a folder.', 2800);
      return;
    }
    const selectedPath = await pickWorkspaceFolderDialog();
    if (!selectedPath) return;

    this.workspaceIndexing = true;
    this.error = null;

    try {
      await this.clearWorkspaceDocs(targetChatId);
      const result = await indexWorkspaceFolder(selectedPath, targetChatId);
      const chat = this.findChat(targetChatId);
      if (!chat) return;
      chat.workspace = buildWorkspaceFromIndexResult(result, Date.now());
      // contextMode stays 'code' — never convert sessions between spaces
      this.touchChats();
      this.persist();
      await this.refreshRagDocuments(targetChatId);
      toastStore.success(
        result.indexed_count > 0
          ? `Workspace ready: ${countOf(result.indexed_count, 'file')} indexed`
          : 'Workspace attached, but no files could be indexed.'
      );
    } finally {
      this.workspaceIndexing = false;
    }
  }

  async addWorkspaceFolder(files: File[]) {
    if (!isElectron()) {
      toastStore.error('Work mode is only available in the desktop app.');
      return;
    }
    const targetChatId = this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    if (!files.length || !targetChatId || !targetChat) return;
    if (normalizeContextMode(targetChat.contextMode) !== 'code') {
      toastStore.info('Switch to the Code tab to attach a folder.', 2800);
      return;
    }

    this.workspaceIndexing = true;
    this.error = null;
    try {
      await this.clearWorkspaceDocs(targetChatId);

      const sortedFiles = [...files].sort((left, right) => getWorkspacePath(left).localeCompare(getWorkspacePath(right)));
      const workspaceFiles: WorkspaceFile[] = [];
      let indexedCount = 0;
      let skippedCount = 0;
      let indexedSoFar = 0;

      for (const file of sortedFiles) {
        const relativePath = getWorkspacePath(file);
        if (!relativePath || shouldIgnoreWorkspacePath(relativePath)) {
          skippedCount += 1;
          continue;
        }

        const workspaceFile: WorkspaceFile = {
          path: relativePath,
          name: file.name,
          size: file.size,
          type: getWorkspaceExtension(relativePath),
          status: 'ready'
        };

        if (!isSupportedWorkspaceFile(relativePath)) {
          workspaceFile.status = 'skipped';
          workspaceFile.reason = 'Unsupported file type';
          skippedCount += 1;
          workspaceFiles.push(workspaceFile);
          continue;
        }

        if (file.size > WORKSPACE_MAX_FILE_SIZE_BYTES) {
          workspaceFile.status = 'skipped';
          workspaceFile.reason = 'File too large';
          skippedCount += 1;
          workspaceFiles.push(workspaceFile);
          continue;
        }

        if (indexedSoFar >= WORKSPACE_MAX_FILES) {
          workspaceFile.status = 'skipped';
          workspaceFile.reason = 'Workspace file limit reached';
          skippedCount += 1;
          workspaceFiles.push(workspaceFile);
          continue;
        }

        try {
          const text = trimWorkspaceText(await file.text());
          if (!text) {
            workspaceFile.status = 'skipped';
            workspaceFile.reason = 'Empty text content';
            skippedCount += 1;
          } else {
            const doc = await ingestText({
              source: relativePath,
              text,
              chat_id: targetChatId,
              file_type: workspaceFile.type
            });
            workspaceFile.docId = doc.id;
            indexedCount += 1;
            indexedSoFar += 1;
          }
        } catch (error) {
          workspaceFile.status = 'error';
          workspaceFile.reason = toErrorMessage(error) || 'Failed to index file';
          skippedCount += 1;
        }

        workspaceFiles.push(workspaceFile);
      }

      const rootName = workspaceFiles[0]?.path.split('/')[0] || sortedFiles[0]?.name || 'Workspace';
      const chat = this.findChat(targetChatId);
      if (!chat) return;
      chat.workspace = {
        rootName,
        rootPath: undefined,
        attachedAt: Date.now(),
        fileCount: workspaceFiles.length,
        indexedCount,
        skippedCount,
        files: workspaceFiles
      };
      // contextMode stays 'code'
      this.touchChats();
      this.persist();
      await this.refreshRagDocuments(targetChatId);

      toastStore.success(
        indexedCount > 0
          ? `Workspace ready: ${countOf(indexedCount, 'file')} indexed`
          : 'Workspace attached, but no files could be indexed.'
      );
    } finally {
      this.workspaceIndexing = false;
    }
  }

  async clearWorkspace() {
    const targetChatId = this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    if (!targetChatId || !targetChat?.workspace) return;
    const docIds = targetChat.workspace.files
      .map((file) => file.docId)
      .filter((docId): docId is string => !!docId);
    await Promise.allSettled(docIds.map((docId) => removeRagDocument(docId, targetChatId)));
    targetChat.workspace = null;
    // Stay in Work — never demote to Chat
    this.touchChats();
    this.persist();
    await this.refreshRagDocuments(targetChatId);
    toastStore.info('Workspace removed from this work session.', 2200);
  }

  /** Re-scan the workspace folder after LLM creates new files */
  async refreshWorkspace(chatId = this.currentChatId || '') {
    const chat = this.findChat(chatId);
    const rootPath = chat?.workspace?.rootPath;
    if (!rootPath || !chatId || !isElectron()) return;
    this.workspaceIndexing = true;
    try {
      await this.clearWorkspaceDocs(chatId);
      const result = await indexWorkspaceFolder(rootPath, chatId);
      chat!.workspace = buildWorkspaceFromIndexResult(result, chat!.workspace!.attachedAt);
      this.touchChats();
      this.persist();
      await this.refreshRagDocuments(chatId);
    } finally {
      this.workspaceIndexing = false;
    }
  }

  /** Create a file inside the workspace from the UI */
  async createWorkspaceFile(relativePath: string, docType: string, content: string): Promise<string> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    const fullPath = await createWorkspaceDocument(rootPath, relativePath, docType, content);
    await this.refreshWorkspace(targetChatId);
    return fullPath;
  }

  async renameWorkspaceFile(oldRelPath: string, newRelPath: string): Promise<void> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    await renameWorkspaceFile(rootPath, oldRelPath, newRelPath);
    await this.refreshWorkspace(targetChatId);
    toastStore.info(`Renamed to ${newRelPath.split('/').pop()}`, 2000);
  }

  async deleteWorkspaceFile(relativePath: string): Promise<void> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    await deleteWorkspaceFile(rootPath, relativePath);
    await this.refreshWorkspace(targetChatId);
    toastStore.info(`Deleted ${relativePath.split('/').pop()}`, 2000);
  }

  async readWorkspaceFile(relativePath: string): Promise<string> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    return readWorkspaceFile(rootPath, relativePath);
  }

  async openWorkspaceFile(relativePath: string): Promise<void> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    const fullPath = `${rootPath}/${relativePath}`;
    await openWorkspaceFile(fullPath, rootPath);
  }

  async createWorkspaceFolder(relativePath: string): Promise<void> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    await createWorkspaceFolder(rootPath, relativePath);
    await this.refreshWorkspace(targetChatId);
    toastStore.info(`Folder created`, 2000);
  }

  private canStartGeneration(params: {
    backendMode: GenerationBackendMode;
    targetChatId: string;
    activeProvider?: { has_api_key?: boolean; api_key?: string; model?: string } | null;
    localBusyActionText?: string;
  }): boolean {
    return canStartGenerationHelper({
      ...params,
      selectedLocalModelPath: this.selectedLocalModelPath,
      localModelActive: Boolean(this.localModelActive),
      isChatGenerating: (chatId) => this.isChatGenerating(chatId),
      hasOtherChatGeneration: (chatId) => this.hasOtherChatGeneration(chatId),
      info: (message, duration) => toastStore.info(message, duration),
      error: (message) => toastStore.error(message)
    });
  }

  /**
   * Send the composer as a user turn, or — with `silent` — generate a
   * character turn without one (group force-talk and auto mode).
   */
  async sendCurrentMessage(options: { silent?: boolean } = {}) {
    const silent = !!options.silent;
    const content = silent ? '' : this.composer.trim();
    const targetChatId = this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    if ((!silent && !content && this.pendingAttachments.length === 0) || !targetChat || !targetChatId) return;

    const activeBackendMode = this.backendMode as GenerationBackendMode;

    const activeModelLabel = this.activeModelLabel;
    const activeProvider = this.activeProvider;
    const activeProviderApiKey = activeProvider?.api_key;
    const activeContextMode = normalizeContextMode(targetChat.contextMode);
    const activeSearchMode = normalizeSessionSearchMode(targetChat.searchMode ?? this.searchMode);
    const activeComposerMode = normalizeSessionComposerMode(targetChat.composerMode ?? this.composerMode, activeContextMode);
    const activeReasoningLevel = targetChat.reasoningLevel ?? this.reasoningLevel;
    const activeWorkspace = activeContextMode === 'code' ? targetChat.workspace : null;
    const targetRagDocuments = this.ragDocumentsByChat[targetChatId] || [];

    if (!this.canStartGeneration({
      backendMode: activeBackendMode,
      targetChatId,
      activeProvider
    })) return;

    this.error = null;
    // A scene without a character cannot be answered: the prompt would be empty
    // and the model would reply as a generic assistant.
    if (activeContextMode === 'roleplay' && !this.roleplayCast(targetChat).length) {
      toastStore.info('This scene has no character. Choose one to continue.', 4000);
      return;
    }
    if (!silent) this.resetRoleplayAuto(targetChatId);
    const targetChatTitle = targetChat?.title || this.defaultTitleForMode(normalizeContextMode(targetChat?.contextMode));
    const workContext = activeContextMode === 'code' && activeWorkspace
      ? {
          rootName: activeWorkspace.rootName,
          fileCount: activeWorkspace.fileCount,
          indexedCount: activeWorkspace.indexedCount
        }
      : null;
    const userMessage: ChatMessage | null = silent
      ? null
      : {
          id: createId('msg'),
          role: 'user',
          content,
          createdAt: Date.now(),
          done: true,
          status: 'idle',
          attachments: this.pendingAttachments,
          mode: activeComposerMode,
          searchMode: activeSearchMode,
          workContext
        };

    // Group scenes: route the reply after the user's turn is in the history, so
    // mentions inside it are seen. A forced speaker wins; a dead end (everyone
    // muted) keeps the message in the composer instead of sending it.
    if (activeContextMode === 'roleplay') {
      const routingMessages = userMessage ? [...targetChat.messages, userMessage] : targetChat.messages;
      const speaker = this.routeRoleplaySpeaker(targetChat, routingMessages);
      if (!speaker && this.roleplayCast(targetChat).length > 1) {
        toastStore.info('Everyone is muted — unmute a character to continue.', 4000);
        return;
      }
      if (speaker) this.roleplaySpeakerOverrides[targetChatId] = speaker;
      else delete this.roleplaySpeakerOverrides[targetChatId];
    }

    if (userMessage) {
      this.appendMessageToChat(targetChatId, userMessage);
      this.composer = '';
      targetChat.draft = '';
    }
    const sentAttachments = silent ? [] : [...this.pendingAttachments];
    if (!silent) this.pendingAttachments = [];

    const modeControl = this.composerModeControl;
    const composerRoute = resolveComposerRoute({
      prompt: content,
      hasAttachments: sentAttachments.length > 0 || targetRagDocuments.length > 0,
      searchMode: activeSearchMode,
      contextMode: activeContextMode
    });
    const useToolLoop = shouldUseToolLoop({
      control: modeControl,
      composerMode: activeComposerMode,
      route: composerRoute,
      searchMode: activeSearchMode,
      contextMode: activeContextMode
    }) && !!targetChatId;

    const assistantMessage: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      // Optimistic ack: intent confirmation with zero latency. The engine's
      // first onContent replaces it wholesale — it never leaks into answers.
      // Seeded only when tools will actually run; direct answers stream fast
      // enough that dots suffice.
      content: useToolLoop && (composerRoute === 'agent' || composerRoute === 'tools')
        ? optimisticAck(content, composerRoute === 'agent' ? 'work' : 'lookup')
        : '',
      createdAt: Date.now(),
      done: false,
      status: 'streaming',
      model: activeModelLabel,
      versions: [],
      activeVersion: 0,
      searchMode: activeSearchMode,
      mode: activeComposerMode,
      // Roleplay turns belong to the character, so the thread can show who spoke.
      speakerId: activeContextMode === 'roleplay' ? this.roleplaySpeakerId(targetChat) : null,
      reasoning: '',
      metadata: useToolLoop
        ? {
            modelName: activeModelLabel,
            ...executionMetadata(activeBackendMode),
            currentActivity: activeComposerMode === 'instant'
              ? 'searching'
              : activeSearchMode !== 'chat' && activeComposerMode !== 'agent'
                ? 'searching'
                : 'planning',
            activityLabel: activityLabel(
              activeComposerMode === 'instant' || (activeSearchMode !== 'chat' && activeComposerMode !== 'agent') ? 'searching' : 'planning'
            )
          }
        : undefined,
      workContext,
      agentSteps: useToolLoop
        ? [{
            id: createId('step'),
            type: 'thinking',
            label: activityLabel(activeComposerMode === 'instant' ? 'searching' : 'planning'),
            status: 'running',
            detail: activeComposerMode === 'instant'
              ? 'Checking sources'
              : activeComposerMode === 'agent'
                ? 'Preparing tools and context'
                : activeSearchMode !== 'chat'
                ? 'Preparing search tools and context'
                : 'Checking if tools are needed'
          }]
        : [],
      artifact: null
    };

    this.appendMessageToChat(targetChatId, assistantMessage);

    const SYNC_INTERVAL_MS = 50;
    let lastSyncTime = 0;
    let trailingSync: ReturnType<typeof setTimeout> | undefined;
    const cancelTrailingSync = () => {
      if (trailingSync === undefined) return;
      clearTimeout(trailingSync);
      trailingSync = undefined;
    };
    const syncMsg = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSyncTime < SYNC_INTERVAL_MS) {
        /*
         * Trailing edge. This throttle used to just set a `pendingSync` flag that
         * only a `flushPendingSync` helper cleared — and that helper was never
         * called anywhere, so the last chunk of a burst sat unrendered until either
         * another chunk arrived or the run finished. Short answers visibly stalled
         * mid-sentence. A timer means the tail always lands ~50ms later at worst.
         */
        if (trailingSync === undefined) {
          trailingSync = setTimeout(() => {
            trailingSync = undefined;
            syncMsg(true);
          }, Math.max(1, SYNC_INTERVAL_MS - (now - lastSyncTime)));
        }
        return;
      }
      cancelTrailingSync();
      lastSyncTime = now;
      const chat = this.findChat(targetChatId);
      if (!chat) return;
      const idx = chat.messages.findIndex((m) => m.id === assistantMessage.id);
      if (idx >= 0) {
        chat.messages[idx] = { ...assistantMessage };
        chat.updatedAt = Date.now();
      }
    };

    const controller = new AbortController();
    const startTime = Date.now();
    const reasoningTimer = startReasoningTimer();
    let exactUsage: CompletionResult['usage'] = null;
    // Declared before the try so the error path can clean the reply too.
    const roleplayAttribution = this.buildRoleplayAttribution(targetChat);
    const roleplayOutputSanitizer = this.buildRoleplayOutputSanitizer(targetChat);
    const roleplayChoicesEnabled = !!targetChat.roleplay?.adventureChoices;
    const roleplayOverrides = this.roleplayRequestOverrides(targetChat);
    let rawRoleplayContent = '';

    /*
     * The run begins inside the `try`, so the `finally` that ends it covers
     * everything. It used to start several statements earlier, and anything that
     * threw in the gap — context building, mode writes — left a run recorded with no
     * matching end. The UI then showed "generating" forever and `canStartGeneration`
     * blocked that chat permanently, with no way back short of a reload.
     */
    try {
      this.beginGenerationRun(targetChatId, {
        controller,
        messageId: assistantMessage.id,
        backendMode: activeBackendMode,
        mode: activeComposerMode,
        startedAt: Date.now()
      });
      const searchConversationContext = userMessage
        ? this.buildSearchConversationContext(userMessage.id, targetChatId)
        : '';
      // Reset modes on the target session (and store mirrors only if still viewing it).
      // The tab is a persistent per-chat preference: Agent and Instant stick,
      // only the one-shot search depth resets. Collapsing Instant to Chat here
      // is exactly how the tab used to jump back on every send.
      const postSendSearch: 'chat' = 'chat';
      const postSendComposer = activeComposerMode === 'agent' ? 'agent' as const : activeComposerMode === 'instant' ? 'instant' as const : 'chat' as const;
      targetChat.searchMode = postSendSearch;
      targetChat.composerMode = postSendComposer;
      if (this.currentChatId === targetChatId) {
        this.searchMode = postSendSearch;
        this.composerMode = targetChat.composerMode || postSendComposer;
      }
      let searchContext = '';
      let sources: ChatMessage['sources'] = [];
      let searchMeta: SearchMeta | null = null;
      let ragContext = '';
      let ragDocuments: IndexedDocument[] = [];
      const workspaceContext = activeWorkspace ? buildWorkspacePrompt(activeWorkspace) : '';

      if (isElectron() && targetRagDocuments.length && activeSearchMode === 'chat') {
        // No tight retrieval budget when the user attached documents — pull more chunks.
        const ragResponse = await queryDocuments({
          query: content || 'summarize key points from the attached documents',
          chat_id: targetChatId,
          top_k: 20
        });
        ragContext = ragResponse.context || '';
        const docIds = new Set(ragResponse.results.map((result) => result.chunk.doc_id));
        ragDocuments = targetRagDocuments.filter((doc) => docIds.has(doc.id));
      }

      assistantMessage.sources = sources;
      assistantMessage.searchMeta = searchMeta;
      assistantMessage.ragDocuments = ragDocuments;
      syncMsg(true); // push initial metadata (sources, searchMeta) to the reactive array
      this.persist();

      const requestMessages = userMessage
        ? buildRequestMessagesWithPatchedUser({
            messages: targetChat.messages,
            assistantMessageId: assistantMessage.id,
            userMessageId: userMessage.id,
            userContent: content,
            attribution: roleplayAttribution,
            buildContextualPrompt: (userContent) => this.buildContextualPrompt({
              content: userContent,
              searchContext,
              researchSummary: (searchMeta as SearchMeta | null)?.researchSummary || '',
              ragContext,
              workspaceContext,
              mode: activeComposerMode,
              searchMode: activeSearchMode
            })
          })
        : buildRequestMessagesFromHistory(
            targetChat.messages,
            targetChat.messages.length - 1,
            roleplayAttribution
          );

      const searchSystemPrefix = searchContext ? buildSearchSystemPrefix() : undefined;
      const systemPrompt = this.buildSystemPromptForMode({
        backendMode: activeBackendMode,
        providerPrompt: activeProvider?.system_prompt,
        searchSystemPrefix,
        includeChartHint: activeComposerMode !== 'agent',
        chat: targetChat,
        speakerId: this.roleplaySpeakerId(targetChat)
      });

      const outboundMessages = appendRoleplayNudge(
        appendRoleplayStoryTurn(
          buildOutboundMessages({ messages: requestMessages, systemPrompt }),
          roleplayOverrides.storyTurn?.instruction
        ),
        roleplayAttribution
      );
      // The routed speaker applies to this turn only.
      delete this.roleplaySpeakerOverrides[targetChatId];
      // Context window budget check (local mode only)
      if (activeBackendMode === 'local' && isElectron()) {
        try {
          const electronApi = getElectronApi();
          if (electronApi) {
            await applyLocalContextBudgetTruncation({
              backendMode: activeBackendMode,
              isElectron: true,
              config: this.config,
              messages: outboundMessages,
              invoke: toInvoke(electronApi),
              // Uploaded / RAG document context must not be token-budget trimmed away.
              preserveDocuments: targetRagDocuments.length > 0 || sentAttachments.length > 0 || !!ragContext,
              onTruncated: (removed) => {
                toastStore.info(`Context window full. ${removed} older message(s) truncated to fit.`, 4000);
              }
            });
          }
        } catch {
          // Silently continue if budget check fails
        }
      }

      // Home uses one conversational agent, with optional research depth.
      const searchToolBudget = activeSearchMode === 'max'
        ? { maxIterations: 48, maxToolCalls: 140, maxTimeMs: 22 * 60 * 1000 }
        : activeSearchMode === 'deep'
          ? { maxIterations: 28, maxToolCalls: 90, maxTimeMs: 14 * 60 * 1000 }
          : activeSearchMode === 'search'
            ? { maxIterations: 10, maxToolCalls: 24, maxTimeMs: 5 * 60 * 1000 }
            : { maxIterations: 12, maxToolCalls: 24, maxTimeMs: 5 * 60 * 1000 };
      const chatAgentBudget = { maxIterations: 12, maxToolCalls: 24, maxTimeMs: 5 * 60 * 1000 };
      // Instant fast path: tight enough that the loop cannot go on a journey.
      const instantBudget = { maxIterations: 4, maxToolCalls: 8, maxTimeMs: 90 * 1000 };

      if (useToolLoop) {
        const isCodeSpace = activeContextMode === 'code';
        const wantsAgent = isCodeSpace;
        const isInstant = activeComposerMode === 'instant' && !wantsAgent;
        const agentProfile =
          activeSearchMode !== 'chat' && !wantsAgent
            ? 'search' as const
            : wantsAgent
              ? (isCodeSpace ? 'work' as const : 'chat' as const)
              : 'chat' as const;
        // Research search modes use search_chat; Instant uses the fast instant profile;
        // chat tools & agent use full tool lists.
        const toolMode =
          isInstant
            ? 'instant' as const
            : activeSearchMode !== 'chat' && !wantsAgent
              ? 'search_chat' as const
              : 'agent' as const;
        const profileBudget =
          isInstant
            ? instantBudget
            : agentProfile === 'search' || activeSearchMode !== 'chat'
              ? searchToolBudget
              : agentProfile === 'chat'
                ? chatAgentBudget
                : {};
        const agentTaskArgs: RunAgentTaskArgs = {
          chatId: targetChatId,
          systemPrompt,
          messages: requestMessages,
          rawPrompt: content,
          conversationContext: searchConversationContext || (ragContext ? `<documents>\n${ragContext}\n</documents>` : undefined),
          executionMode: 'sandbox',
          workspaceName: activeWorkspace?.rootName,
          workspaceFiles: activeWorkspace?.files,
          toolMode,
          agentProfile,
          searchMode: activeSearchMode === 'chat' ? undefined : activeSearchMode,
          reasoningLevel: activeReasoningLevel,
          quietActivity: isInstant,
          onContent: (value) => {
            assistantMessage.content = value;
            syncMsg();
          },
          preserveDocumentContext: targetRagDocuments.length > 0 || sentAttachments.length > 0 || !!ragContext,
          ...profileBudget,
          signal: controller.signal,
          onStep: (steps) => {
            assistantMessage.agentSteps = steps;
            if (!isInstant) {
              const running = steps.find((step) => step.status === 'running');
              if (running) {
                const mapped = activityFromProgress(running.label);
                setAgentActivity(assistantMessage, mapped.currentActivity, mapped.activityLabel);
              }
            }
            syncMsg(true);
            this.persist();
          },
          onProgress: (text) => {
            if (isInstant) {
              syncMsg();
              return;
            }
            const mapped = activityFromProgress(text);
            setAgentActivity(assistantMessage, mapped.currentActivity, mapped.activityLabel);
            syncMsg();
          },
          onReasoning: (value) => {
            reasoningTimer.markStarted();
            assistantMessage.reasoning = value;
            syncMsg();
          },
          onArtifact: (artifacts) => {
            const latest = artifacts.length ? artifacts[artifacts.length - 1] : null;
            assistantMessage.artifacts = artifacts;
            assistantMessage.artifact = latest;
            syncMsg(true);
            this.persist();
            if (this.currentChatId === targetChatId && (latest || this.currentArtifactMessageId === assistantMessage.id)) {
              this.setCurrentArtifact(latest, assistantMessage.id);
            }
          },
          onSources: (liveSources) => {
            const existingUrls = new Set((assistantMessage.sources || []).map((s) => s.url));
            const newSources = liveSources.filter((s) => !existingUrls.has(s.url));
            if (newSources.length) {
              assistantMessage.sources = [...(assistantMessage.sources || []), ...newSources];
              if (!assistantMessage.searchMode || assistantMessage.searchMode === 'chat') {
                assistantMessage.searchMode = 'search';
              }
              syncMsg(true);
              this.persist();
            }
          }
        };
        const agentResult = await runAgentTask(agentTaskArgs);
        exactUsage = agentResult.usage || exactUsage;
        markAgentWriting(assistantMessage);
        syncMsg(true);
        this.persist();
        // Handle agent result - check for errors or warnings
        const outcome = agentOutcome(agentResult);
        const stopReason = agentStopReason(agentResult);
        const usableAgentResult = hasUsableAgentResult(agentResult);
        if (outcome === 'failed' && agentResult.error && !usableAgentResult) {
          // Fatal agent failure: no usable evidence/content was produced.
          const friendly = humanizeAgentError(agentResult.error);
          assistantMessage.content = agentResult.content?.trim()
            ? agentResult.content
            : friendly;
          assistantMessage.status = 'error';
          assistantMessage.done = true;
          assistantMessage.metadata = {
            ...finalizeAssistantMetadata({
              modelName: activeModelLabel,
              backendMode: activeBackendMode,
              noUsageTimingScope: 'agent_wall',
              overrides: {
                error: true,
                errorMessage: friendly,
                outcome,
                stopReason,
                currentActivity: 'stopped',
                activityLabel: 'Agent failed',
                workProduct: agentResult.artifact?.workProduct ? {
                  id: agentResult.artifact.workProduct.id,
                  kind: agentResult.artifact.workProduct.kind,
                  title: agentResult.artifact.workProduct.title,
                  primaryFile: agentResult.artifact.workProduct.files[0]?.path,
                  status: agentResult.artifact.workProduct.status
                } : undefined,
                publicFallback: !!agentResult.publicFallback,
                diagnosticsRedacted: !!agentResult.diagnosticsRedacted
              }
            })
          };
        } else if (agentResult.warning || outcome === 'partial' || outcome === 'stopped') {
          // Partial/stopped agents keep their evidence and render as a normal answer with a warning.
          assistantMessage.content = agentResult.content;
          assistantMessage.done = true;
          assistantMessage.status = 'idle';
          assistantMessage.metadata = {
            ...finalizeAssistantMetadata({
              modelName: activeModelLabel,
              backendMode: activeBackendMode,
              noUsageTimingScope: 'agent_wall',
              overrides: {
                warning: agentResult.warning
                  || (agentResult.error ? humanizeAgentError(agentResult.error) : undefined)
                  || 'Stopped before finishing. You can continue the conversation.',
                outcome,
                stopReason,
                currentActivity: 'stopped',
                activityLabel: 'Stopped',
                workProduct: agentResult.artifact?.workProduct ? {
                  id: agentResult.artifact.workProduct.id,
                  kind: agentResult.artifact.workProduct.kind,
                  title: agentResult.artifact.workProduct.title,
                  primaryFile: agentResult.artifact.workProduct.files[0]?.path,
                  status: agentResult.artifact.workProduct.status
                } : undefined,
                publicFallback: !!agentResult.publicFallback,
                diagnosticsRedacted: !!agentResult.diagnosticsRedacted
              }
            })
          };
          if (agentResult.error && !usableAgentResult) {
            if (this.config.ui?.agent_debug_logs) {
              console.warn('[agent]', agentResult.warning || agentResult.error);
            }
          } else {
            if (this.config.ui?.agent_debug_logs) {
              console.info('[agent]', agentResult.warning || 'Agent stopped with usable gathered evidence.');
            }
          }
        } else {
          assistantMessage.content = agentResult.content;
          assistantMessage.metadata = {
            ...(assistantMessage.metadata || {}),
            ...executionMetadata(activeBackendMode),
            outcome,
            stopReason,
            currentActivity: 'completed',
            activityLabel: 'Agent finished',
            workProduct: agentResult.artifact?.workProduct ? {
              id: agentResult.artifact.workProduct.id,
              kind: agentResult.artifact.workProduct.kind,
              title: agentResult.artifact.workProduct.title,
              primaryFile: agentResult.artifact.workProduct.files[0]?.path,
              status: agentResult.artifact.workProduct.status
            } : undefined,
            publicFallback: !!agentResult.publicFallback,
            diagnosticsRedacted: !!agentResult.diagnosticsRedacted
          };
        }
        assistantMessage.reasoning = agentResult.reasoning;
        const prevSteps = assistantMessage.agentSteps || [];
        const diffSteps = prevSteps.filter((s) => s.diffStats?.length && !agentResult.steps.some((rs) => rs.id === s.id));
        assistantMessage.agentSteps = [...agentResult.steps, ...diffSteps];
        assistantMessage.artifact = agentResult.artifact;
        if (agentResult.sources?.length) {
          const existingUrls = new Set((assistantMessage.sources || []).map((s) => s.url));
          const newSources = agentResult.sources.filter((s) => !existingUrls.has(s.url));
          if (newSources.length) {
            assistantMessage.sources = [...(assistantMessage.sources || []), ...newSources];
          }
          if (!assistantMessage.searchMode || assistantMessage.searchMode === 'chat') {
            assistantMessage.searchMode = 'search';
          }
          assistantMessage.searchMeta = {
            ...(assistantMessage.searchMeta || {
              searchRequested: true,
              searchSucceeded: true,
              contextAvailable: true,
              sourceCount: 0
            }),
            searchRequested: true,
            searchSucceeded: true,
            contextAvailable: true,
            sourceCount: assistantMessage.sources.length,
            stopReason
          };
        } else if (activeSearchMode !== 'chat') {
          assistantMessage.searchMeta = {
            ...(assistantMessage.searchMeta || {}),
            searchRequested: true,
            searchSucceeded: !agentResult.error,
            contextAvailable: false,
            sourceCount: assistantMessage.sources?.length || 0,
            requestedProvider: this.config.search?.provider || 'aggregator',
            searchError: agentResult.error || agentResult.warning || '',
            stopReason
          };
        }
        syncMsg(true);
        this.persist();
        if (this.currentChatId === targetChatId && (agentResult.artifact || this.currentArtifactMessageId === assistantMessage.id)) {
          this.setCurrentArtifact(agentResult.artifact, assistantMessage.id);
        }
        // Agent artifacts are chat-sandboxed, so there is no host workspace write to rescan here.
      } else {
        await streamAssistantReply({
          messages: outboundMessages,
          signal: controller.signal,
          apiKey: activeProviderApiKey,
          reasoningLevel: activeReasoningLevel,
          sampling: roleplayOverrides.sampling,
          stop: roleplayOverrides.stop,
          onChunk: (value) => {
            reasoningTimer.markStopped();
            // Keep the raw accumulation: at finalize it is the only faithful
            // source for the choices and prop blocks the sanitizer strips out.
            if (roleplayOverrides.stop.length) rawRoleplayContent += value;
            appendStreamingContent(
              assistantMessage,
              value,
              assistantMessage.reasoning || '',
              assistantMessage.metadata,
              roleplayOutputSanitizer
            );
            if (assistantMessage.agentSteps?.length) {
              assistantMessage.agentSteps = assistantMessage.agentSteps.map((step, index, all) => {
                if (index === all.length - 1) {
                  return { ...step, status: 'running', detail: 'Streaming response' };
                }
                return step;
              });
            }
            syncMsg(); // ← CRITICAL: replace array slot so Svelte 5 sees the new object
          },
          onReasoning: (value) => {
            reasoningTimer.markStarted();
            assistantMessage.reasoning = appendStreamingReasoning(assistantMessage.reasoning || '', value);
            updateStreamingVersion(
              assistantMessage,
              assistantMessage.content,
              assistantMessage.reasoning,
              assistantMessage.metadata
            );
            syncMsg();
          },
          onUsage: (usage) => {
            exactUsage = usage || exactUsage;
          }
        });
      }

      assistantMessage.done = true;
      // Roleplay: never store the `Name:` prefix the model echoed back, lift
      // adventure choices into their own field, and trim whatever leaked past
      // the stop strings (a stream that dies mid-`\nUser` leaves a fragment).
      if (roleplayOutputSanitizer || roleplayOverrides.stop.length) {
        const source = rawRoleplayContent || assistantMessage.content;
        const parsed = roleplayChoicesEnabled
          ? extractRoleplayChoices(source)
          : { text: source, choices: [] as string[] };
        if (parsed.choices.length) assistantMessage.choices = parsed.choices;
        const handed = extractRoleplayProps(parsed.text);
        if (handed.props.length) assistantMessage.props = handed.props;
        const trimmed = stripTrailingPartialStop(handed.text, roleplayOverrides.stop);
        assistantMessage.content = roleplayOutputSanitizer ? roleplayOutputSanitizer(trimmed) : trimmed;
        const storyTurn = roleplayOverrides.storyTurn;
        if (storyTurn) {
          assistantMessage.storyTurn = {
            label: storyTurn.label,
            ...(storyTurn.kind ? { kind: storyTurn.kind } : {}),
            ...(storyTurn.intensity ? { intensity: storyTurn.intensity } : {})
          };
        }
      }
      // Only set status to 'idle' if it wasn't already set to 'error'
      if (assistantMessage.status !== 'error') {
        assistantMessage.status = 'idle';
      }
      const timing = (Date.now() - startTime) / 1000;
      assistantMessage.metadata = finalizeAssistantMetadata({
        existing: assistantMessage.metadata,
        modelName: activeModelLabel,
        backendMode: activeBackendMode,
        usage: exactUsage,
        elapsedSeconds: timing,
        totalElapsedSeconds: timing,
        reasoningElapsedSeconds: reasoningTimer.elapsedSeconds()
      });
      assistantMessage.model = activeModelLabel;
      assistantMessage.versions = [{
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt,
        reasoning: assistantMessage.reasoning,
        metadata: assistantMessage.metadata
      }];
      if (assistantMessage.agentSteps?.length) {
        const hasError = assistantMessage.metadata?.error;
        const hasWarning = assistantMessage.metadata?.warning;
        assistantMessage.agentSteps = assistantMessage.agentSteps.map((step, index, all) => {
          if (index === all.length - 1) {
            if (hasError) {
              return { ...step, status: 'error', detail: step.detail || 'Agent encountered an error' };
            } else if (hasWarning) {
              return { ...step, status: 'done', detail: hasWarning };
            }
            return { ...step, status: 'done', detail: assistantMessage.metadata?.outcome === 'completed' ? 'Response ready' : step.detail };
          }
          return { ...step, status: step.status === 'running' ? 'done' : step.status };
        });
      }

      const responseSources = ((assistantMessage.sources && assistantMessage.sources.length)
        ? assistantMessage.sources
        : sources) as SearchResult[];
      if (targetChatId && responseSources.length > 0) {
        this.queueWebAnswerRagIngest({
          chatId: targetChatId,
          query: content,
          answer: assistantMessage.content,
          sources: responseSources
        });
      }

      // ── Work mode file writing ──────────────────────────────────────
      // Code space only: home sandbox replies never touch host disk here.
      // Fence blocks execute only for code-context agent turns with a
      // workspace attached; main-side containment is second layer.
      const activeWorkspaceRoot = activeWorkspace?.rootPath;
      if (activeContextMode === 'code' && activeComposerMode !== 'agent' && activeWorkspaceRoot && isElectron() && assistantMessage.content) {
        const blocks = parseWriteFileBlocks(assistantMessage.content);
        if (blocks.length > 0) {
          const created: import('$lib/types/chat').CreatedFile[] = [];
          for (const block of blocks) {
            try {
              const fullPath = await writeWorkspaceFile(activeWorkspaceRoot, block.path, block.content);
              created.push({ path: block.path, name: block.path.split('/').pop() || block.path, fullPath });
            } catch (writeErr) {
              toastStore.error(`Could not write ${block.path}: ${String((writeErr as Error)?.message || writeErr)}`);
            }
          }
          if (created.length > 0) {
            assistantMessage.filesCreated = created;
            assistantMessage.content = stripWriteFileBlocks(assistantMessage.content, created);
            assistantMessage.versions = [{
              content: assistantMessage.content,
              createdAt: assistantMessage.createdAt,
              reasoning: assistantMessage.reasoning,
              metadata: assistantMessage.metadata
            }];
            toastStore.success(
              created.length === 1
                ? `File created: ${created[0].name}`
                : `${created.length} files created in workspace`
            );
            // Auto-refresh workspace so new files appear in sidebar
            void this.refreshWorkspace(targetChatId);
          }
        }
      }
      // ───────────────────────────────────────────────────────────────

      syncMsg(true);
      this.persist();

      if (this.config.tts?.enable_voice_output && this.config.tts?.auto_play_voice && assistantMessage.content) {
        try {
          void ttsStore.speak(assistantMessage.id, assistantMessage.content, this.config);
        } catch {
          // ignore TTS auto-play failures
        }
      }

      // Auto-generate a smarter chat title after the first exchange
      void this.generateChatTitle(targetChatId, activeProviderApiKey);
    } catch (error) {
      const errorMsg = toErrorMessage(error) || 'Request failed';
      const aborted = isAbortLikeError(errorMsg);
      // Don't show toast for user-initiated abort
      if (!aborted) {
        toastStore.error(errorMsg.length > 80 ? errorMsg.slice(0, 80) + '…' : errorMsg);
      }
      assistantMessage.done = true;
      assistantMessage.status = aborted ? 'idle' : 'error';
      assistantMessage.content = aborted ? (assistantMessage.content || '') : (assistantMessage.content || errorMsg);
      const timing = typeof startTime === 'number' ? (Date.now() - startTime) / 1000 : 0;
      assistantMessage.metadata = finalizeAssistantMetadata({
        existing: assistantMessage.metadata,
        modelName: activeModelLabel,
        backendMode: activeBackendMode,
        elapsedSeconds: timing,
        totalElapsedSeconds: timing,
        reasoningElapsedSeconds: reasoningTimer.elapsedSeconds(),
        overrides: aborted ? {} : { error: true, errorMessage: errorMsg }
      });
      assistantMessage.model = activeModelLabel;
      assistantMessage.versions = [{
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt,
        reasoning: assistantMessage.reasoning,
        metadata: assistantMessage.metadata
      }];
      if (assistantMessage.agentSteps?.length) {
        if (aborted) {
          markAgentStopped(assistantMessage);
        } else {
          assistantMessage.agentSteps = assistantMessage.agentSteps.map((step, index, all) => {
            if (index === all.length - 1) return { ...step, status: 'error', detail: assistantMessage.content };
            return step;
          });
        }
      }
      this.error = aborted ? null : assistantMessage.content;
      if (roleplayOutputSanitizer) {
        assistantMessage.content = roleplayOutputSanitizer(assistantMessage.content);
      }
      if (userMessage) userMessage.attachments = sentAttachments;
      syncMsg(true);
      this.persist();
    } finally {
      // The trailing timer must not outlive the run — it would write to a message
      // the user may have already stopped.
      cancelTrailingSync();
      this.endGenerationRun(targetChatId, controller);
      // Group auto mode: queue the next character turn once this one settles.
      // A stopped or failed turn ends the chain instead of retrying.
      this.maybeContinueRoleplayAuto(targetChatId, controller.signal.aborted || assistantMessage.status === 'error');
    }
  }

  stopStreaming(chatId = this.currentChatId || '') {
    // The browser tool sets this when an agent starts driving a page, and only
    // the normal agent exit used to clear it — aborting left the "Agent" badge
    // stuck on the browser panel. Stopping a run is always a safe reset point.
    browserPanelStore.agentDriving = false;
    const run = chatId ? this.activeRunsByChat[chatId] : null;
    run?.controller.abort();
    if (run) {
      this.endGenerationRun(chatId, run.controller);
    } else {
      this.refreshGenerationState();
    }
    const chat = this.findChat(chatId);
    if (chat) {
      const streamingAssistant = [...chat.messages].reverse().find((message) => message.role === 'assistant' && (message.status === 'streaming' || ((message.mode === 'agent' || message.mode === 'instant') && !message.done)));
      if (streamingAssistant) {
        streamingAssistant.status = 'idle';
        streamingAssistant.done = true;
        if (!(streamingAssistant.content || '').trim()) {
          streamingAssistant.content = 'Stopped by user.';
        }
        if (streamingAssistant.agentSteps?.length) {
          markAgentStopped(streamingAssistant);
        }
        this.touchChats();
        this.persist();
        saveChatStateToDb(chat);
      }
    }
    if (run?.messageId) {
      deepResearchStore.cancelTaskForMessage(run.messageId);
    } else if (chatId) {
      deepResearchStore.cancelTasksForChat(chatId);
    }
    // Exit voice mode when user explicitly cancels generation
    if (chatId === this.currentChatId && this.voiceModeActive) {
      this.voiceModeActive = false;
    }
  }

  private async generateChatTitle(chatId = this.currentChatId || '', apiKey = this.activeProvider?.api_key) {
    const chat = this.findChat(chatId);
    if (!chat) return;
    // Need at least one user + one assistant message
    const userMsg = chat.messages.find((m) => m.role === 'user');
    const assistantMsg = chat.messages.find((m) => m.role === 'assistant' && m.done && m.content);
    if (!userMsg || !assistantMsg) return;

    const provisional = userMsg.content.trim().replace(/\s+/g, ' ').slice(0, 48);
    // Only auto-rewrite if title is still default or provisional quick title.
    if (!this.isDefaultTitle(chat) && chat.title !== provisional) return;

    try {
      const result = await completeAssistantReply({
        apiKey,
        messages: [
          {
            role: 'system',
            content: 'Generate a concise, specific 4-6 word title for this conversation. Reply with ONLY the title — no quotes, no punctuation at the end, no explanation.'
          },
          {
            role: 'user',
            content: `User asked: ${userMsg.content.slice(0, 300)}\nAssistant replied: ${assistantMsg.content.slice(0, 300)}`
          }
        ]
      });

      const generated = result.content
        .trim()
        .replace(/^["']|["']$/g, '')   // strip surrounding quotes
        .replace(/[.!?]+$/, '')         // strip trailing punctuation
        .trim();

      if (generated && generated.length >= 4 && generated.length <= 80 && (this.isDefaultTitle(chat) || chat.title === provisional)) {
        chat.title = generated;
        this.touchChats();
        this.persist();
      }
    } catch {
      // Title generation is best-effort, never show errors to user
    }
  }

  async regenerateMessage(messageId: string) {
    const chat = this.currentChat;
    const targetChatId = this.currentChatId;
    if (!chat || !targetChatId) return;
    const index = chat.messages.findIndex((entry) => entry.id === messageId);
    const message = index >= 0 ? chat.messages[index] : null;
    if (!message || message.role !== 'assistant') return;

    const roleplayAttribution = this.buildRoleplayAttribution(chat, message.speakerId);
    const roleplayOutputSanitizer = this.buildRoleplayOutputSanitizer(chat);
    const roleplayChoicesEnabled = !!chat.roleplay?.adventureChoices;
    const roleplayOverrides = this.roleplayRequestOverrides(chat, message.speakerId);
    let rawRoleplayContent = '';
    const previousMessages = buildRequestMessagesFromHistory(chat.messages, index - 1, roleplayAttribution);
    if (!previousMessages.length) return;

    const activeBackendMode = this.backendMode as GenerationBackendMode;
    const activeModelLabel = this.activeModelLabel;
    const activeProvider = this.activeProvider;
    if (!this.canStartGeneration({
      backendMode: activeBackendMode,
      targetChatId,
      activeProvider,
      localBusyActionText: 'retrying here'
    })) return;
    const activeProviderApiKey = activeProvider?.api_key;
    const activeWorkspace = chat.workspace || null;

    this.error = null;
    const controller = new AbortController();
    const startTime = Date.now();
    const reasoningTimer = startReasoningTimer();
    let exactUsage: CompletionResult['usage'] = null;

    const nextVersion: MessageVersion = {
      content: '',
      reasoning: '',
      createdAt: Date.now(),
      metadata: {
        modelName: activeModelLabel,
        ...executionMetadata(activeBackendMode)
      }
    };

    message.versions = [...(message.versions || []), nextVersion];
    message.activeVersion = message.versions.length - 1;
    // Same optimistic ack as a fresh send: intent confirmation now, replaced
    // wholesale by the engine's first content. Instant regens were grounded
    // before, so they read as lookups.
    const regenPrompt = [...chat.messages.slice(0, index)].reverse().find((entry) => entry.role === 'user')?.content || '';
    message.content = (message.mode === 'agent' || message.mode === 'instant')
      ? optimisticAck(regenPrompt, message.mode === 'agent' ? 'work' : 'lookup')
      : '';
    message.reasoning = '';
    message.done = false;
    message.status = 'streaming';
    if (message.mode === 'agent' || message.mode === 'instant') {
      const instantRegen = message.mode === 'instant';
      message.agentSteps = [
        { id: createId('step'), type: 'thinking', label: activityLabel(instantRegen ? 'searching' : 'planning'), status: 'running', detail: instantRegen ? 'Checking sources' : 'Preparing tools and context' }
      ];
      message.metadata = {
        ...(message.metadata || {}),
        modelName: activeModelLabel,
        ...executionMetadata(activeBackendMode),
        currentActivity: instantRegen ? 'searching' : 'planning',
        activityLabel: instantRegen ? activityLabel('searching') : 'Working'
      };
      nextVersion.metadata = {
        ...(nextVersion.metadata || {}),
        ...executionMetadata(activeBackendMode),
        currentActivity: message.mode === 'instant' ? 'searching' : 'planning',
        activityLabel: message.mode === 'instant' ? activityLabel('searching') : 'Working'
      };
      message.artifact = null;
      message.artifacts = [];
      if (this.currentArtifactMessageId === message.id) {
        this.setCurrentArtifact(null, message.id, false);
      }
    }
    this.touchChats();

    /*
     * The run begins inside the `try` so the `finally` that ends it always runs.
     * `persist()` used to sit between `beginGenerationRun` and this `try`, and it
     * writes localStorage synchronously — a quota error there recorded a run that
     * could never be ended, pinning the chat in "generating" for the rest of the
     * session.
     */
    try {
      this.beginGenerationRun(targetChatId, {
        controller,
        messageId: message.id,
        backendMode: activeBackendMode,
        mode: (message.mode === 'instant' ? 'instant' : message.mode === 'agent' ? 'agent' : 'chat'),
        startedAt: Date.now()
      });
      this.persist();
      const styledSystemPrompt = this.buildSystemPromptForMode({
        backendMode: activeBackendMode,
        providerPrompt: activeProvider?.system_prompt,
        chat,
        speakerId: message.speakerId
      });
      const outboundMessages = appendRoleplayNudge(
        appendRoleplayStoryTurn(
          buildOutboundMessages({ messages: previousMessages, systemPrompt: styledSystemPrompt }),
          roleplayOverrides.storyTurn?.instruction
        ),
        roleplayAttribution
      );
      if (message.mode === 'agent' || message.mode === 'instant') {
        const rawPrompt = [...chat.messages.slice(0, index)].reverse().find((entry) => entry.role === 'user')?.content || '';
        const ctxMode = normalizeContextMode(chat.contextMode);
        const regenProfile = ctxMode === 'code' ? 'work' as const : 'chat' as const;
        // Regenerating an Instant answer stays on the Instant fast path (allowlist +
        // tight budgets + quiet activity) instead of widening to full agent.
        const isInstantRegen = message.mode === 'instant' || (message.mode !== 'agent' && chat.composerMode === 'instant');
        const instantRegenBudget = { maxIterations: 4, maxToolCalls: 8, maxTimeMs: 90 * 1000 };
        /*
         * The original turn's search depth is carried over. Without it, regenerating a
         * Deep or Max research answer silently re-ran as a plain chat agent — same
         * question, far shallower answer, and no indication why.
         */
        const regenSearchMode = message.searchMode && message.searchMode !== 'chat'
          ? message.searchMode
          : undefined;
        const regenArgs: RunAgentTaskArgs = {
          chatId: targetChatId,
          systemPrompt: styledSystemPrompt,
          messages: previousMessages,
          rawPrompt,
          executionMode: 'sandbox',
          workspaceName: activeWorkspace?.rootName,
          workspaceFiles: activeWorkspace?.files,
          toolMode: isInstantRegen ? ('instant' as const) : 'agent',
          agentProfile: regenSearchMode ? 'search' as const : regenProfile,
          ...(regenSearchMode ? { searchMode: regenSearchMode } : {}),
          quietActivity: isInstantRegen,
          conversationContext: this.buildSearchConversationContext(message.id, targetChatId),
          reasoningLevel: chat.reasoningLevel ?? this.reasoningLevel,
          onContent: (value) => {
            nextVersion.content = value;
            message.content = value;
            this.touchChats();
          },
          ...(regenProfile === 'chat' && !regenSearchMode && !isInstantRegen ? { maxIterations: 12, maxToolCalls: 24, maxTimeMs: 5 * 60 * 1000 } : {}),
          ...(isInstantRegen ? instantRegenBudget : {}),
          signal: controller.signal,
          onStep: (steps) => {
            message.agentSteps = steps;
            if (isInstantRegen) {
              this.touchChats();
              this.persist();
              return;
            }
            const running = steps.find((step) => step.status === 'running');
            if (running) {
              const mapped = activityFromProgress(running.label);
              setAgentActivity(message, mapped.currentActivity, mapped.activityLabel);
              nextVersion.metadata = {
                ...(nextVersion.metadata || {}),
                currentActivity: mapped.currentActivity,
                activityLabel: mapped.activityLabel
              };
            }
            this.touchChats();
            this.persist();
          },
          onProgress: (text) => {
            if (isInstantRegen) {
              this.touchChats();
              return;
            }
            const mapped = activityFromProgress(text);
            setAgentActivity(message, mapped.currentActivity, mapped.activityLabel);
            nextVersion.metadata = {
              ...(nextVersion.metadata || {}),
              currentActivity: mapped.currentActivity,
              activityLabel: mapped.activityLabel
            };
            this.touchChats();
          },
          onReasoning: (value) => {
            reasoningTimer.markStarted();
            nextVersion.reasoning = value;
            message.reasoning = value;
            this.touchChats();
          },
          onArtifact: (artifacts) => {
            const latest = artifacts.length ? artifacts[artifacts.length - 1] : null;
            message.artifacts = artifacts;
            message.artifact = latest;
            if (this.currentChatId === targetChatId && (latest || this.currentArtifactMessageId === message.id)) {
              this.setCurrentArtifact(latest, message.id);
            }
            this.touchChats();
            this.persist();
          },
          onSources: (liveSources) => {
            const existingUrls = new Set((message.sources || []).map((s) => s.url));
            const newSources = liveSources.filter((s) => !existingUrls.has(s.url));
            if (newSources.length) {
              message.sources = [...(message.sources || []), ...newSources];
              if (!message.searchMode || message.searchMode === 'chat') {
                message.searchMode = 'search';
              }
              this.touchChats();
              this.persist();
            }
          }
        };
        const agentResult = await runAgentTask(regenArgs);
        markAgentWriting(message);
        nextVersion.metadata = {
          ...(nextVersion.metadata || {}),
          currentActivity: 'writing',
          activityLabel: activityLabel('writing')
        };
        this.touchChats();
        this.persist();
        const outcome = agentOutcome(agentResult);
        const stopReason = agentStopReason(agentResult);
        const usableAgentResult = hasUsableAgentResult(agentResult);
        if (outcome === 'failed' && agentResult.error && !usableAgentResult) {
          nextVersion.content = agentResult.content || agentResult.error;
          message.content = agentResult.content || agentResult.error;
          message.status = 'error';
          nextVersion.metadata = {
            ...finalizeAssistantMetadata({
              existing: nextVersion.metadata,
              modelName: activeModelLabel,
              backendMode: activeBackendMode,
              noUsageTimingScope: 'agent_wall',
              overrides: {
                error: true,
                errorMessage: agentResult.error,
                outcome,
                stopReason,
                currentActivity: 'stopped',
                activityLabel: 'Agent failed',
                workProduct: agentResult.artifact?.workProduct ? {
                  id: agentResult.artifact.workProduct.id,
                  kind: agentResult.artifact.workProduct.kind,
                  title: agentResult.artifact.workProduct.title,
                  primaryFile: agentResult.artifact.workProduct.files[0]?.path,
                  status: agentResult.artifact.workProduct.status
                } : undefined,
                publicFallback: !!agentResult.publicFallback,
                diagnosticsRedacted: !!agentResult.diagnosticsRedacted
              }
            })
          };
          message.metadata = nextVersion.metadata;
        } else if (agentResult.warning || outcome === 'partial' || outcome === 'stopped') {
          nextVersion.content = agentResult.content;
          message.content = agentResult.content;
          message.status = 'idle';
          nextVersion.metadata = {
            ...finalizeAssistantMetadata({
              existing: nextVersion.metadata,
              modelName: activeModelLabel,
              backendMode: activeBackendMode,
              noUsageTimingScope: 'agent_wall',
              overrides: {
                warning: agentResult.warning || agentResult.error || 'Agent stopped before normal completion.',
                outcome,
                stopReason,
                currentActivity: 'stopped',
                activityLabel: 'Agent stopped',
                workProduct: agentResult.artifact?.workProduct ? {
                  id: agentResult.artifact.workProduct.id,
                  kind: agentResult.artifact.workProduct.kind,
                  title: agentResult.artifact.workProduct.title,
                  primaryFile: agentResult.artifact.workProduct.files[0]?.path,
                  status: agentResult.artifact.workProduct.status
                } : undefined,
                publicFallback: !!agentResult.publicFallback,
                diagnosticsRedacted: !!agentResult.diagnosticsRedacted
              }
            })
          };
          message.metadata = nextVersion.metadata;
        } else {
          nextVersion.content = agentResult.content;
          message.content = agentResult.content;
          nextVersion.metadata = {
            ...(nextVersion.metadata || {}),
            ...executionMetadata(activeBackendMode),
            outcome,
            stopReason,
            currentActivity: 'completed',
            activityLabel: 'Agent finished',
            workProduct: agentResult.artifact?.workProduct ? {
              id: agentResult.artifact.workProduct.id,
              kind: agentResult.artifact.workProduct.kind,
              title: agentResult.artifact.workProduct.title,
              primaryFile: agentResult.artifact.workProduct.files[0]?.path,
              status: agentResult.artifact.workProduct.status
            } : undefined,
            publicFallback: !!agentResult.publicFallback,
            diagnosticsRedacted: !!agentResult.diagnosticsRedacted
          };
          message.metadata = nextVersion.metadata;
        }
        nextVersion.reasoning = agentResult.reasoning;
        message.reasoning = agentResult.reasoning;
        message.agentSteps = agentResult.steps;
        message.artifact = agentResult.artifact;
        if (agentResult.sources?.length) {
          const existingUrls = new Set((message.sources || []).map((s) => s.url));
          const newSources = agentResult.sources.filter((s) => !existingUrls.has(s.url));
          message.sources = [...(message.sources || []), ...newSources];
          if (!message.searchMode || message.searchMode === 'chat') {
            message.searchMode = 'search';
          }
          message.searchMeta = {
            ...(message.searchMeta || {
              searchRequested: true,
              searchSucceeded: true,
              contextAvailable: true,
              sourceCount: 0
            }),
            searchRequested: true,
            searchSucceeded: true,
            contextAvailable: true,
            sourceCount: message.sources.length,
            stopReason
          };
        }
        if (this.currentChatId === targetChatId && (agentResult.artifact || this.currentArtifactMessageId === message.id)) {
          this.setCurrentArtifact(agentResult.artifact, message.id);
        }
        this.touchChats();
        this.persist();
        // Agent regeneration also stays inside the chat sandbox.
      } else {
        await streamAssistantReply({
          messages: outboundMessages,
          signal: controller.signal,
          apiKey: activeProviderApiKey,
          reasoningLevel: this.reasoningLevel,
          sampling: roleplayOverrides.sampling,
          stop: roleplayOverrides.stop,
          onChunk: (value) => {
            reasoningTimer.markStopped();
            // Keep the raw accumulation: at finalize it is the only faithful
            // source for the choices and prop blocks the sanitizer strips out.
            if (roleplayOverrides.stop.length) rawRoleplayContent += value;
            const nextContent = nextVersion.content + value;
            nextVersion.content = roleplayOutputSanitizer ? roleplayOutputSanitizer(nextContent) : nextContent;
            message.content = nextVersion.content;
            nextVersion.reasoning = message.reasoning;
            this.touchChats();
          },
          onReasoning: (value) => {
            reasoningTimer.markStarted();
            nextVersion.reasoning = appendStreamingReasoning(nextVersion.reasoning || '', value);
            message.reasoning = nextVersion.reasoning;
            this.touchChats();
          },
          onUsage: (usage) => {
            exactUsage = usage || exactUsage;
          }
        });
      }

      const timing = (Date.now() - startTime) / 1000;
      nextVersion.metadata = finalizeAssistantMetadata({
        existing: nextVersion.metadata,
        modelName: activeModelLabel,
        backendMode: activeBackendMode,
        usage: exactUsage,
        elapsedSeconds: timing,
        totalElapsedSeconds: timing,
        reasoningElapsedSeconds: reasoningTimer.elapsedSeconds()
      });
      if (roleplayOutputSanitizer || roleplayOverrides.stop.length) {
        const source = rawRoleplayContent || nextVersion.content;
        const parsed = roleplayChoicesEnabled
          ? extractRoleplayChoices(source)
          : { text: source, choices: [] as string[] };
        if (parsed.choices.length) message.choices = parsed.choices;
        const handed = extractRoleplayProps(parsed.text);
        if (handed.props.length) message.props = handed.props;
        const trimmed = stripTrailingPartialStop(handed.text, roleplayOverrides.stop);
        nextVersion.content = roleplayOutputSanitizer ? roleplayOutputSanitizer(trimmed) : trimmed;
        message.content = nextVersion.content;
        const storyTurn = roleplayOverrides.storyTurn;
        if (storyTurn) {
          message.storyTurn = {
            label: storyTurn.label,
            ...(storyTurn.kind ? { kind: storyTurn.kind } : {}),
            ...(storyTurn.intensity ? { intensity: storyTurn.intensity } : {})
          };
        }
      }
      message.metadata = nextVersion.metadata;
      message.model = activeModelLabel;
      message.done = true;
      // Only set status to 'idle' if it wasn't already set to 'error'
      if (message.status !== 'error') {
        message.status = 'idle';
      }
      if (message.mode === 'slides') {
        try {
          const slides = await parseSlidesFromMarkdown(nextVersion.content);
          message.slides = slides.length ? slides : [];
        } catch {
          message.slides = [];
        }
      }
      if (message.agentSteps?.length) {
        const hasError = message.metadata?.error;
        const hasWarning = message.metadata?.warning;
        message.agentSteps = message.agentSteps.map((step, stepIndex, all) => {
          if (stepIndex === all.length - 1) {
            if (hasError) {
              return { ...step, status: 'error', detail: step.detail || 'Agent encountered an error' };
            } else if (hasWarning) {
              return { ...step, status: 'done', detail: hasWarning };
            }
            return { ...step, status: 'done', detail: message.metadata?.outcome === 'completed' ? 'Response ready' : step.detail };
          }
          return { ...step, status: step.status === 'running' ? 'done' : step.status };
        });
      }
      this.touchChats();
      this.persist();
    } catch (error) {
      const timing = (Date.now() - startTime) / 1000;
      const failure = toErrorMessage(error) || 'Request failed';
      const aborted = isAbortLikeError(failure);
      nextVersion.content = aborted ? (nextVersion.content || '') : (nextVersion.content || failure);
      nextVersion.metadata = {
        ...finalizeAssistantMetadata({
          existing: nextVersion.metadata,
          modelName: activeModelLabel,
          backendMode: activeBackendMode,
          elapsedSeconds: timing,
          totalElapsedSeconds: timing,
          reasoningElapsedSeconds: reasoningTimer.elapsedSeconds(),
          overrides: aborted ? {} : { error: true, errorMessage: failure }
        })
      };
      message.content = nextVersion.content;
      message.reasoning = nextVersion.reasoning || '';
      message.metadata = nextVersion.metadata;
      message.done = true;
      message.status = aborted ? 'idle' : 'error';
      this.error = aborted ? null : failure;
      if (aborted && message.agentSteps?.length) {
        markAgentStopped(message);
      }
      this.touchChats();
      this.persist();
    } finally {
      this.endGenerationRun(targetChatId, controller);
    }
  }

  setMessageActiveVersion(messageId: string, direction: -1 | 1) {
    const chat = this.currentChat;
    if (!chat) return;
    const message = chat.messages.find((entry) => entry.id === messageId);
    if (!message?.versions?.length) return;
    const current = typeof message.activeVersion === 'number' ? message.activeVersion : 0;
    const next = Math.max(0, Math.min(current + direction, message.versions.length - 1));
    if (next === current) return;
    message.activeVersion = next;
    this.touchChats();
    this.persist();
  }

  private _apiModelsCacheKey(): string | null {
    const isLocal = this.config.llm?.backend_mode === 'local' && isElectron();
    if (isLocal) return null;
    const providerName = this.config.llm?.provider || 'openai';
    const provider = this.config.llm?.providers?.[providerName];
    const baseUrl = provider?.base_url || '';
    return `${providerName}:${baseUrl}`;
  }

  private async commitConfig(next: AppConfig, options: {
    refreshModels?: boolean;
    refreshLocalStatus?: boolean;
    detectTools?: boolean;
  } = {}) {
    this.config = next;
    await saveAppConfig(next);
    if (options.refreshModels) {
      await this.refreshModels();
    }
    if (isElectron() && options.detectTools) {
      detectToolSupport().catch(() => {});
      this.refreshReasoningCapabilities().catch(() => {});
    }
    if (isElectron() && options.refreshLocalStatus) {
      await modelsStore.refreshStatus();
    }
  }

  async refreshModels(force?: boolean) {
    if (this.backendMode === 'local' && isElectron()) {
      this.modelsRefreshing = true;
      try {
        await modelsStore.refreshIndex();
        const localModels = await Promise.all(modelsStore.availableModels.map(async (m) =>
          buildLocalModelOption(m, !!(m.path && await this.detectMmprojForModel(m.path)))
        ));
        this.models = localModels;
      } catch {
        this.models = [];
      } finally {
        this.modelsRefreshing = false;
      }
      return;
    }

    const cacheKey = this._apiModelsCacheKey();
    if (cacheKey && !force) {
      const cached = this._apiModelsCache.get(cacheKey);
      if (cached) {
        this.models = cached;
        return;
      }
    }
    this.modelsRefreshing = true;
    try {
      const data = await fetchModels(this.config);
      this.models = data;
      if (cacheKey && data.length > 0) {
        this._apiModelsCache.set(cacheKey, data);
      }
    } catch {
      this.models = [];
    } finally {
      this.modelsRefreshing = false;
    }
  }

  async updateProvider(partial: {
    provider: string;
    base_url?: string;
    api_key?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    system_prompt?: string;
    extra_models?: string[];
  }, opts: { activate?: boolean } = {}) {
    const next = mergeProviderConfig(this.config, partial, opts);
    await this.commitConfig(next, {
      refreshModels: true,
      detectTools: true,
      refreshLocalStatus: next.llm?.backend_mode === 'local'
    });
  }

  /**
   * Register a user-added OpenAI-compatible endpoint. The key and model are
   * stored through updateProvider under llm.providers[id] as usual; only the
   * directory entry lives in llm.custom_providers.
   */
  async addCustomProvider(input: { label: string; base_url: string }): Promise<string> {
    const slug = input.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
    const existing = this.config.llm?.custom_providers ?? [];
    let id = `custom-${slug}`;
    let n = 2;
    while (existing.some((p) => p.id === id)) id = `custom-${slug}-${n++}`;
    await this.commitConfig({
      ...this.config,
      llm: { ...this.config.llm, custom_providers: [...existing, { id, label: input.label.trim(), base_url: input.base_url.trim() }] }
    }, { refreshModels: false });
    return id;
  }

  /** Remove a custom endpoint and its stored credential/model entry. */
  async removeCustomProvider(id: string): Promise<void> {
    const list = (this.config.llm?.custom_providers ?? []).filter((p) => p.id !== id);
    const providers = { ...(this.config.llm?.providers ?? {}) };
    delete providers[id];
    const wasActive = this.config.llm?.provider === id;
    await this.commitConfig({
      ...this.config,
      llm: {
        ...this.config.llm,
        custom_providers: list,
        providers,
        ...(wasActive ? { provider: '' } : {})
      }
    }, { refreshModels: true });
  }

  async setBackendMode(mode: 'local' | 'api') {
    const current = this.config.llm?.backend_mode || (isElectron() ? 'local' : 'api');
    if (current === mode) return;
    await this.commitConfig(setBackendModeConfig(this.config, mode), {
      refreshModels: true,
      detectTools: true,
      refreshLocalStatus: true
    });
  }

  /**
   * Point chats at a provider id ('' = none active) without touching its
   * stored fields — the settings toggle's primitive.
   */
  async setActiveProvider(id: string) {
    await this.commitConfig({
      ...this.config,
      llm: { ...this.config.llm, provider: id }
    }, { refreshModels: true, detectTools: true });
  }

  async updateLocalModel(model: ModelOption) {
    await this.commitConfig(setLocalModelConfig(this.config, model), {
      refreshModels: true,
      detectTools: true,
      refreshLocalStatus: true
    });
  }

  async updateLocalSettings(partial: {
    base_url?: string;
    runtime_path?: string;
    context_length?: number;
    gpu_layers?: number;
    cpu_threads?: number;
    batch_size?: number;
    flash_attention?: boolean;
    offload_kv_cache?: boolean;
    keep_in_memory?: boolean;
    mmap?: boolean;
    seed?: number | null;
    rope_freq_base?: number | null;
    rope_freq_scale?: number | null;
    parallel?: number | null;
    cache_type_k?: string;
    cache_type_v?: string;
    mmproj_path?: string;
    system_prompt?: string;
    temperature?: number;
    max_tokens?: number;
    thinking_mode?: LocalThinkingMode;
    /** Legacy equivalent of thinking_mode 'off'; cleared on write. */
    disable_thinking?: boolean;
  }) {
    await this.commitConfig(mergeLocalSettingsConfig(this.config, partial), {
      refreshLocalStatus: true
    });
  }

  async stopLocalModel() {
    if (!isElectron()) return;
    await stopLlama();
    this.localModelActive = null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await modelsStore.refreshStatus();
    await this.refreshModels();
  }

  async setLocalRuntimePath(path: string) {
    await this.updateLocalSettings({ runtime_path: path });
    this.localModelLoadRuntimePath = path;
  }

  async updateUiSettings(partial: {
    show_assistant_text?: boolean;
    enable_thinking?: boolean;
    artifact_toggles?: Record<string, boolean>;
    composer_mode_control?: 'tabs' | 'auto';
    roleplay_enabled?: boolean;
  }) {
    await this.commitConfig(mergeUiSettingsConfig(this.config, partial));
  }

  get composerModeControl(): 'tabs' | 'auto' {
    return this.config.ui?.composer_mode_control === 'tabs' ? 'tabs' : 'auto';
  }

  /** Whether the Roleplay space is enabled (Settings → General). */
  get roleplayEnabled(): boolean {
    return this.config.ui?.roleplay_enabled === true;
  }

  async setRoleplayEnabled(enabled: boolean) {
    await this.updateUiSettings({ roleplay_enabled: enabled });
    // Leaving the space while it is disabled must not strand the user in it.
    if (!enabled && this.activeSpace === 'roleplay') {
      this.setActiveSpace('home');
    }
  }

  getArtifactToggles(): Record<string, boolean> {
    return this.config.ui?.artifact_toggles || {};
  }

  async updateArtifactToggles(partial: Record<string, boolean>) {
    const current = this.getArtifactToggles();
    const merged = { ...current, ...partial };
    await this.commitConfig(mergeUiSettingsConfig(this.config, { artifact_toggles: merged }));
  }

  async updatePromptSettings(partial: {
    system_prompt?: string;
    user_prompt?: string;
    local_system_prompt?: string;
  }) {
    await this.commitConfig(mergePromptSettingsConfig(this.config, partial));
  }

  async updateSearchSettings(partial: {
    provider?: string;
    max_results?: number;
    context_budget_chars?: number;
    aggregator_engines?: string[];
    safe_search?: number;
    providers?: NonNullable<AppConfig['search']>['providers'];
  }) {
    await this.commitConfig(mergeSearchSettingsConfig(this.config, partial));
  }

  async updateTtsSettings(partial: {
    enable_voice_output?: boolean;
    auto_play_voice?: boolean;
    voice?: string;
    speed?: number;
    volume?: number;
    engine?: 'kokoro' | 'wasm' | 'browser';
    model_path?: string;
    voices_path?: string;
    tokens_path?: string;
    lexicon_path?: string;
    dict_dir?: string;
    data_dir?: string;
    model_variant?: string;
  }) {
    await this.commitConfig(mergeTtsSettingsConfig(this.config, partial));
  }
}

export const appStore = new AppStore();
