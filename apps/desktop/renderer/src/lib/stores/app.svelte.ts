import type { AgentArtifact, AppConfig, Attachment, ChatContextMode, ChatFolder, ChatMessage, ChatSession, LocalThinkingMode, MessageVersion, ModelOption, ReasoningCapabilities, ReasoningLevel, WorkspaceFile } from '$lib/types/chat';
import type { Attachment as CodeAttachment } from '$shared/agente-protocol.gen';
import { SPACES } from '$lib/spaces';
import { approvalsStore } from '$lib/stores/approvals.svelte';
import type { IndexedDocument, SearchResult } from '$lib/types/bridge';
import { countOf } from '$lib/utils/format';
import { runAgentTask } from '$lib/services/agent';
import { applyHomeAgentResult, homeAgentCallbacks, initialHomeActivity, planHomeAgentRun, settleAgentSteps } from '$lib/features/home/home-turn';
import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
import { messageSpeechParts } from '$lib/features/roleplay/roleplay-voice';
import { CONTINUE_INSTRUCTION, joinContinuation } from '$lib/features/roleplay/roleplay-steer';
import { charactersStore } from '$lib/features/roleplay/characters.svelte';
import { resolveComposerRoute, shouldUseToolLoop } from '$lib/services/composer-route';
import { parseSlidesFromMarkdown } from '$lib/services/slides';
import { writeTempFile, pathExists, pickWorkspaceFolder as pickWorkspaceFolderDialog, indexWorkspaceFolder, createWorkspaceDocument, renameWorkspaceFile, deleteWorkspaceFile, readWorkspaceFile, openWorkspaceFile, createWorkspaceFolder } from '$lib/services/files';
import { clearRagDocuments, ingestDocument, ingestText, ingestTextFast, listRagDocuments, queryDocuments, removeRagDocument } from '$lib/services/rag';
import { webSearch } from '$lib/services/search';
import { getRecommendedSettings, loadLocalModel, onSupervisorEvent, stopLlama } from '$lib/services/runtime';
import { invoke, isElectron } from '$lib/services/bridge';
import { downloadsStore } from '$lib/stores/downloads.svelte';
import { deepResearchStore } from '$lib/stores/deep-research.svelte';
import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
import { modelsStore } from '$lib/stores/models.svelte';
import { ttsStore } from '$lib/stores/tts.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { confirmStore } from '$lib/stores/confirm.svelte';
import { get } from 'svelte/store';
import { _ as translate } from 'svelte-i18n';
import type { CompletionResult, RequestMessage } from '$lib/services/chat-api';
import { completeAssistantReply, detectToolSupport, fetchModels, fetchReasoningCapabilities, hasConfiguredVisionModel, loadChatConfig, reasoningRouteIdentity, streamAssistantReply } from '$lib/services/chat-api';
import { loadChatState, saveChatState, saveAppConfig, saveChatStateToDb, loadChatStateFromDb, deleteChatFromDb } from '$lib/utils/storage';
import { toErrorMessage } from '$lib/utils/errors';
import { describeLocalLoadError } from '$lib/utils/local-load-errors';
import { resolveContextBudgetPreview } from '$lib/stores/app-context-budget-preview';
import { buildSystemPrompt, selectBaseSystemPrompt } from '$lib/stores/app-prompts';
import {
  applyLocalContextBudgetTruncation,
  buildOutboundMessages,
  buildRequestMessagesWithPatchedUser
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
  readBlobAsDataUrl,
  repairRoleplayChat,
  startReasoningTimer,
  toInvoke,
  updateStreamingVersion,
  withTimeout,
  isDefaultChatTitle,
  type ApiModelMetadata,
  type AssistantMetadata,
  type ContextBudget,
  type ElectronApi
} from '$lib/stores/app-store-helpers';
import { DEFAULT_PROVIDER_ID } from '$shared/providers';

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
  /** What the Home surface shows: the chat, or the Artifacts screen. */
  homeView = $state<'chat' | 'artifacts'>('chat');
  /**
   * The Bots tab is showing. Bots aren't chats, so it sits beside the spaces
   * instead of being one: opening any chat or space closes it.
   */
  botsOpen = $state(false);

  /** The top-bar tab that is showing: a space, or Bots. */
  get activeTab(): ChatContextMode | 'bots' {
    return this.botsOpen ? 'bots' : this.activeSpace;
  }
  /** The artifact open on the Artifacts screen (`chatId:messageId:index`), or the library. */
  artifactScreenKey = $state<string | null>(null);
  /** Opened from a chat: Back returns there instead of to the library. */
  artifactReturnChatId = $state<string | null>(null);
  /** Per chat: the artifact open in the chat's side panel. */
  artifactPanels = $state<Record<string, { messageId: string; index: number }>>({});
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
  /** The load dialog starts another instance (Models → Running) instead of replacing the chat model. */
  localModelLoadAsInstance = $state(false);
  /** Instance mode: bind to the local network. */
  localModelLoadShare = $state(false);
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
  /** Why the last load failed, in words; cleared when a new load starts. */
  localModelLoadError = $state('');
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
    return this.config.llm?.provider || DEFAULT_PROVIDER_ID;
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

  private buildSystemPromptForMode(args: {
    backendMode: GenerationBackendMode;
    providerPrompt?: string;
    includeChartHint?: boolean;
    chat?: ChatSession | null;
    /** Roleplay: the character whose reply is being generated. */
    speakerId?: string | null;
    roleplaySnapshot?: MessageVersion['metadata'];
  }): string {
    const chat = args.chat ?? this.currentChat;
    if (normalizeContextMode(chat?.contextMode) === 'roleplay') {
      return roleplayStore.systemPrompt(chat, args.speakerId, args.roleplaySnapshot?.roleplay);
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

  /** The current chat's side-panel artifact, if one is open. */
  get artifactPanel(): { chatId: string; messageId: string; index: number } | null {
    const chatId = this.currentChat?.id;
    const ref = chatId ? this.artifactPanels[chatId] : undefined;
    return chatId && ref ? { chatId, ...ref } : null;
  }

  /** Open an artifact beside its chat; the same artifact again toggles it shut. */
  openArtifactPanel(chatId: string, messageId: string, index: number) {
    const current = this.artifactPanels[chatId];
    const same = current?.messageId === messageId && current.index === index;
    const next = { ...this.artifactPanels };
    if (same) delete next[chatId];
    else next[chatId] = { messageId, index };
    this.artifactPanels = next;
  }

  closeArtifactPanel(chatId: string) {
    if (!this.artifactPanels[chatId]) return;
    const next = { ...this.artifactPanels };
    delete next[chatId];
    this.artifactPanels = next;
  }

  /** Show the Bots screen (the roster, a bot's chat and its routines). */
  showBots() {
    this.botsOpen = true;
    this.persist();
  }

  /** Show the Artifacts library. */
  showArtifactLibrary() {
    this.artifactScreenKey = null;
    this.artifactReturnChatId = null;
    this.homeView = 'artifacts';
  }

  /** Open one artifact full-screen; Back goes to `returnChatId` when given. */
  openArtifactScreen(chatId: string, messageId: string, index: number, returnChatId: string | null = chatId) {
    this.artifactScreenKey = `${chatId}:${messageId}:${index}`;
    this.artifactReturnChatId = returnChatId;
    this.homeView = 'artifacts';
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

  async openLocalModelLoadDialog(model: LocalModelLoadTarget, options: { asInstance?: boolean } = {}) {
    if (!model.path) return;
    this.localModelLoadAsInstance = !!options.asInstance;
    this.localModelLoadShare = false;
    this.localModelLoadTarget = model;
    // Reopening during a load shows its progress; only a fresh dialog resets it.
    if (this.localModelLoading) return;
    this.localModelLoadRuntimePath = this.config.llm?.local?.runtime_path || '';
    this.localModelLoadProgress = 0;
    this.localModelLoadPhase = '';
    this.localModelLoadError = '';
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

  /** Hides the dialog. A load in progress keeps running and reporting. */
  closeLocalModelLoadDialog() {
    this.localModelLoadTarget = null;
    this.localModelLoadAsInstance = false;
    if (this.localModelLoading) return;
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

  /** The full launch config from the dialog, for another instance (no port/host: main picks them). */
  private buildInstanceLaunchConfig(path: string): Record<string, unknown> {
    const num = (value: unknown) => (value === '' || value == null || !Number.isFinite(Number(value)) ? undefined : Number(value));
    return {
      model_path: path,
      backend_mode: 'auto',
      runtime_path: this.localModelLoadRuntimePath || this.config.llm?.local?.runtime_path || undefined,
      context_length: num(this.localModelLoadContextLength) || undefined,
      gpu_offload: num(this.localModelLoadGpuLayers),
      cpu_threads: num(this.localModelLoadCpuThreads) || undefined,
      batch_size: num(this.localModelLoadBatchSize) || undefined,
      flash_attention: this.localModelLoadFlashAttention,
      offload_kv_cache: this.localModelLoadOffloadKvCache,
      keep_in_memory: this.localModelLoadKeepInMemory,
      mmap: this.localModelLoadMmap,
      seed: num(this.localModelLoadSeed),
      parallel: num(this.localModelLoadParallel),
      rope_freq_base: num(this.localModelLoadRopeFreqBase),
      rope_freq_scale: num(this.localModelLoadRopeFreqScale),
      cache_type_k: this.localModelLoadCacheTypeK || undefined,
      cache_type_v: this.localModelLoadCacheTypeV || undefined,
      mmproj_path: this.localModelLoadMmprojPath || undefined,
      thinking_mode: this.localModelLoadThinkingMode === 'auto' ? undefined : this.localModelLoadThinkingMode,
      mtp: this.localModelLoadMtpEnabled,
      mtp_draft_path: this.localModelLoadMtpDraftPath || undefined,
      mtp_draft_n_max: num(this.localModelLoadMtpDraftNMax),
      cpu_moe: this.localModelLoadCpuMoe,
      n_cpu_moe: num(this.localModelLoadNCpuMoe),
      context_shift: this.localModelLoadContextShift,
      cache_ram_mb: num(this.localModelLoadCacheRamMb),
      cache_reuse: num(this.localModelLoadCacheReuse),
      swa_full: this.localModelLoadSwaFull,
      split_mode: this.localModelLoadSplitMode || undefined
    };
  }

  /** Instance mode: launch next to the running models, leave chat as it is. */
  private async startLocalInstanceFromDialog(path: string) {
    this.localModelLoading = true;
    this.localModelLoadError = '';
    this.localModelLoadProgress = 20;
    this.localModelLoadPhase = 'Starting another instance';
    try {
      await invoke('start_instance', { model_path: path, config: this.buildInstanceLaunchConfig(path), share: this.localModelLoadShare });
      this.localModelLoadTarget = null;
      this.localModelLoadAsInstance = false;
    } catch (err) {
      this.localModelLoadError = err instanceof Error ? err.message : String(err);
    } finally {
      this.localModelLoading = false;
      this.localModelLoadProgress = 0;
      this.localModelLoadPhase = '';
    }
  }

  async confirmLocalModelLoad() {
    // The dialog can be hidden mid-load, which clears localModelLoadTarget.
    const target = this.localModelLoadTarget;
    if (!target?.path || this.localModelLoading) return;
    if (this.localModelLoadAsInstance) {
      await this.startLocalInstanceFromDialog(target.path);
      return;
    }
    this.localModelLoading = true;
    this.localModelLoadError = '';
    this.localModelLoadProgress = 5;
    this.localModelLoadPhase = 'Preparing load configuration';
    try {
      // Re-detect mmproj in case it wasn't found during dialog open
      if (!this.localModelLoadMmprojPath && target.path) {
        this.localModelLoadMmprojPath = await this.detectMmprojForModel(target.path);
      }
      await this.setBackendMode('local');
      this.localModelLoadProgress = 12;
      this.localModelLoadPhase = 'Saving local model selection';
      await this.updateLocalModel({
        id: target.id,
        name: target.name,
        path: target.path,
        source: 'local',
        details: target.details
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
        remembered[target.id] = buildRememberedLocalModelSettingsEntry(loadState);
      } else {
        delete remembered[target.id];
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
          target,
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
        name: target.name || 'local model',
        path: target.path || '',
        hasMmproj: !!(this.localModelLoadMmprojPath),
      };
      toastStore.success(`Model loaded: ${target.name || 'local model'}`);
      if (isElectron()) {
        detectToolSupport().catch(() => {});
        // Forced: a fresh server just came up, so re-probe even when the
        // model identity is unchanged.
        this.refreshReasoningCapabilities(true).catch(() => {});
      }
      if (this.localModelLoadTarget === target) this.localModelLoadTarget = null;
    } catch (error) {
      const message = describeLocalLoadError(toErrorMessage(error));
      this.localModelLoadError = message;
      this.localModelLoadProgress = 0;
      this.localModelLoadPhase = '';
      // The dialog may be hidden: the toast is how the failure reaches the user.
      toastStore.error(message);
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
        this.ensureChatForSpace(this.activeSpace);
      } else if (!this.currentChat) {
        // Stay in active space. Never fallback to chats[0] cross-space.
        this.currentChatId = this.resolveChatIdForSpace(this.activeSpace);
        if (!this.currentChatId) this.ensureChatForSpace(this.activeSpace);
      }
      this.activeSpace = normalizeContextMode(this.currentChat?.contextMode || this.activeSpace);
      this.rebuildChatIdBySpace();
      this.hydrateUiFromChat(this.currentChat);
      // Restored last: making the space's chat above closes the tab.
      this.botsOpen = !!loadChatState<PersistedState>({ chats: [], folders: [], currentChatId: null }).botsOpen;
    } catch (error) {
      this.error = toErrorMessage(error) || 'Failed to initialize application';
      if (!this.chats.length) {
        this.ensureChatForSpace(this.activeSpace);
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
      currentChatIdBySpace: this.currentChatIdBySpace,
      botsOpen: this.botsOpen
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
    // A Code conversation only exists inside a project; one without a
    // project cannot run, so it is never picked as the space's current chat.
    const eligible = (chat: ChatSession) =>
      normalizeContextMode(chat.contextMode) === mode && (mode !== 'code' || !!chat.projectId);
    const remembered = this.currentChatIdBySpace[mode];
    if (remembered) {
      const chat = this.findChat(remembered);
      if (chat && eligible(chat)) return remembered;
    }
    return this.chats.find(eligible)?.id || null;
  }

  /**
   * Give a space something to show. Home and Roleplay get a fresh chat; Code
   * does not — its conversations are created inside a project, so an empty
   * Code space shows the project picker instead of an invisible stray chat.
   */
  private ensureChatForSpace(mode: ChatContextMode) {
    if (normalizeContextMode(mode) !== 'code') {
      this.createChat(mode);
      return;
    }
    this.currentChatId = null;
    this.hydrateUiFromChat(null);
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
    this.homeView = 'chat';
    this.botsOpen = false;
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
    this.ensureChatForSpace(nextMode);
  }

  createChat(mode: ChatContextMode = this.activeSpace, options: { workspace?: ChatSession['workspace'] } = {}) {
    this.homeView = 'chat';
    this.botsOpen = false;
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

  selectChat(chatId: string) {
    this.homeView = 'chat';
    this.botsOpen = false;
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
    if (this.currentChatId && this.updateChatDraft(this.currentChatId, value)) this.persist();
  }

  /** Drafts are mutated here, where the chat state is owned, by stable id. */
  updateChatDraft(chatId: string, value: string, attachments?: CodeAttachment[]): boolean {
    const chat = this.findChat(chatId);
    if (!chat) return false;
    let changed = chat.draft !== value;
    if (changed) chat.draft = value;
    if (attachments && chat.codeAgent) {
      const previous = chat.codeAgent.draftAttachments ?? [];
      const same = previous.length === attachments.length && previous.every((item, index) => {
        const next = attachments[index]!;
        return item.path === next.path && item.name === next.name && item.kind === next.kind && item.mime === next.mime && item.bytes === next.bytes;
      });
      if (!same) {
        chat.codeAgent.draftAttachments = attachments.map((item) => ({ ...item }));
        changed = true;
      }
    }
    if (changed) {
      if (chatId === this.currentChatId) this.composer = value;
      this.markChatDirty(chatId);
    }
    return changed;
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
  readonly chatDeletedHooks = new Set<(chatId: string, chat: ChatSession | undefined) => void>();

  /**
   * Register per-chat cache teardown. The hook gets the deleted chat too, since
   * it is already gone from `chats` by the time hooks run. Returns an unregister
   * function.
   */
  onChatDeleted(hook: (chatId: string, chat: ChatSession | undefined) => void): () => void {
    this.chatDeletedHooks.add(hook);
    return () => this.chatDeletedHooks.delete(hook);
  }

  /** `silent` skips the toast (bulk deletes, e.g. a whole Code project). */
  deleteChat(chatId: string, options: { silent?: boolean } = {}) {
    if (this.isChatGenerating(chatId)) {
      this.stopStreaming(chatId);
    }
    const deleted = this.chats.find((c) => c.id === chatId);
    const title = deleted?.title;
    const deletedMode = normalizeContextMode(deleted?.contextMode || this.activeSpace);
    this.chats = this.chats.filter((chat) => chat.id !== chatId);
    for (const hook of this.chatDeletedHooks) {
      // A feature cache failing to tear down must never block the deletion.
      try { hook(chatId, deleted); } catch { /* ignore */ }
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
      if (!this.currentChat) this.ensureChatForSpace(this.activeSpace);
    }
    if (!this.chats.length && this.activeSpace !== 'code') this.createChat(this.activeSpace);
    this.persist();
    if (isElectron()) {
      clearRagDocuments(chatId).catch(() => {});
    }
    deleteChatFromDb(chatId).catch(() => {});
    if (!options.silent) toastStore.info(`Chat deleted${title ? `: ${title}` : ''}`, 2500);
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
      if (chat.contextMode === 'roleplay' && message.metadata?.roleplay) {
        // A prose edit cannot silently keep machine-derived consequences.
        message.metadata = { ...message.metadata, roleplay: { ...message.metadata.roleplay, sceneAfter: message.metadata.roleplay.sceneBefore, contributions: [], choices: [], props: [] } };
        const version = message.versions?.[message.activeVersion ?? 0];
        if (version) version.metadata = message.metadata;
        message.choices = [];
        message.props = [];
      }
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

  appendMessageToChat(chatId: string, message: ChatMessage) {
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

  findChat(chatId: string | null | undefined) {
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
        const providerName = config.llm?.provider || DEFAULT_PROVIDER_ID;
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
    const targetRagDocuments = this.ragDocumentsByChat[targetChatId] || [];

    if (!this.canStartGeneration({
      backendMode: activeBackendMode,
      targetChatId,
      activeProvider
    })) return;

    this.error = null;
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
          searchMode: activeSearchMode
        };
    if (userMessage && targetChat.contextMode === 'roleplay') {
      const persona = charactersStore.getPersonaById(targetChat.personaId) ?? charactersStore.defaultPersona;
      userMessage.metadata = { roleplayPersona: { id: persona?.id ?? null, name: persona?.name || this.userName || 'User', avatar: persona?.avatar } };
    }

    // Scenes: a user turn resets the auto chain, and the reply is routed after
    // the user's turn is in the history so mentions inside it are seen. A scene
    // nobody can answer keeps the message in the composer instead of sending it.
    if (!silent && activeContextMode === 'roleplay') roleplayStore.resetAuto(targetChatId);
    if (!roleplayStore.routeTurn(targetChat, userMessage ? [...targetChat.messages, userMessage] : targetChat.messages)) return;

    if (userMessage) {
      this.appendMessageToChat(targetChatId, userMessage);
      this.composer = '';
      targetChat.draft = '';
    }
    const sentAttachments = silent ? [] : [...this.pendingAttachments];
    if (!silent) this.pendingAttachments = [];

    const composerRoute = resolveComposerRoute({
      prompt: content,
      hasAttachments: sentAttachments.length > 0 || targetRagDocuments.length > 0,
      searchMode: activeSearchMode,
      contextMode: activeContextMode
    });
    const useToolLoop = shouldUseToolLoop({
      control: this.composerModeControl,
      composerMode: activeComposerMode,
      route: composerRoute,
      searchMode: activeSearchMode,
      contextMode: activeContextMode
    });
    const plan = planHomeAgentRun({ composerMode: activeComposerMode, searchMode: activeSearchMode });
    const initial = initialHomeActivity(plan, activeComposerMode);
    // Spends the routed speaker and any queued story turn: one turn, one generation.
    const turn = roleplayStore.prepareTurn(targetChat, { consumeRouting: true });

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
      speakerId: turn.speakerId,
      reasoning: '',
      metadata: useToolLoop
        ? {
            modelName: activeModelLabel,
            ...executionMetadata(activeBackendMode),
            currentActivity: initial.activity,
            activityLabel: activityLabel(initial.activity)
          }
        : undefined,
      agentSteps: useToolLoop
        ? [{
            id: createId('step'),
            type: 'thinking',
            label: activityLabel(initial.activity),
            status: 'running',
            detail: initial.detail
          }]
        : [],
      artifact: null
    };
    if (turn.snapshot) assistantMessage.metadata = { ...assistantMessage.metadata, roleplay: turn.snapshot };

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
        // Trailing edge: the last chunk of a burst must land even when no
        // further chunk arrives, or short answers stall mid-sentence.
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
    const snapshotVersion = () => {
      assistantMessage.versions = [{
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt,
        reasoning: assistantMessage.reasoning,
        metadata: assistantMessage.metadata
      }];
    };

    const controller = new AbortController();
    const startTime = Date.now();
    const reasoningTimer = startReasoningTimer();
    let exactUsage: CompletionResult['usage'] = null;

    /*
     * The run begins inside the `try`, so the `finally` that ends it covers
     * everything. Anything that threw between starting and the `try` used to
     * leave a run with no matching end: "generating" forever, and
     * `canStartGeneration` blocking that chat until a reload.
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
      // only the one-shot search depth resets.
      const postSendComposer = activeComposerMode === 'agent' ? 'agent' as const : activeComposerMode === 'instant' ? 'instant' as const : 'chat' as const;
      targetChat.searchMode = 'chat';
      targetChat.composerMode = postSendComposer;
      if (this.currentChatId === targetChatId) {
        this.searchMode = 'chat';
        this.composerMode = targetChat.composerMode || postSendComposer;
      }
      let ragContext = '';
      let ragDocuments: IndexedDocument[] = [];

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
      const preserveDocuments = targetRagDocuments.length > 0 || sentAttachments.length > 0 || !!ragContext;

      assistantMessage.sources = [];
      assistantMessage.searchMeta = null;
      assistantMessage.ragDocuments = ragDocuments;
      syncMsg(true);
      this.persist();

      const requestMessages = userMessage
        ? buildRequestMessagesWithPatchedUser({
            messages: targetChat.messages,
            assistantMessageId: assistantMessage.id,
            userMessageId: userMessage.id,
            userContent: content,
            attribution: turn.attribution,
            buildContextualPrompt: (userContent) => this.buildContextualPrompt({
              content: userContent,
              searchContext: '',
              researchSummary: '',
              ragContext,
              workspaceContext: '',
              mode: activeComposerMode,
              searchMode: activeSearchMode
            })
          })
        : buildRequestMessagesFromHistory(
            targetChat.messages,
            targetChat.messages.length - 1,
            turn.attribution
          );

      const systemPrompt = this.buildSystemPromptForMode({
        backendMode: activeBackendMode,
        providerPrompt: activeProvider?.system_prompt,
        includeChartHint: activeComposerMode !== 'agent',
        chat: targetChat,
        speakerId: turn.speakerId,
        roleplaySnapshot: { roleplay: turn.snapshot }
      });

      const outboundMessages = turn.decorate(buildOutboundMessages({ messages: requestMessages, systemPrompt }));
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
              preserveDocuments,
              onTruncated: (removed) => {
                toastStore.info(`Context window full. ${removed} older message(s) truncated to fit.`, 4000);
              }
            });
          }
        } catch {
          // Silently continue if budget check fails
        }
      }

      if (useToolLoop) {
        const agentResult = await runAgentTask({
          chatId: targetChatId,
          systemPrompt,
          messages: requestMessages,
          rawPrompt: content,
          conversationContext: searchConversationContext || (ragContext ? `<documents>\n${ragContext}\n</documents>` : undefined),
          executionMode: 'sandbox',
          toolMode: plan.toolMode,
          agentProfile: plan.agentProfile,
          searchMode: plan.searchMode,
          reasoningLevel: activeReasoningLevel,
          quietActivity: plan.instant,
          preserveDocumentContext: preserveDocuments,
          ...plan.budget,
          signal: controller.signal,
          ...homeAgentCallbacks({
            message: assistantMessage,
            quiet: plan.instant,
            sync: syncMsg,
            persist: () => this.persist(),
            onReasoningStart: () => reasoningTimer.markStarted(),
            onArtifacts: (latest) => this.focusArtifact(targetChatId, assistantMessage.id, latest)
          })
        });
        exactUsage = agentResult.usage || exactUsage;
        markAgentWriting(assistantMessage);
        syncMsg(true);
        this.persist();
        applyHomeAgentResult(assistantMessage, agentResult, {
          modelName: activeModelLabel,
          backendMode: activeBackendMode,
          searchMode: plan.searchMode,
          requestedProvider: this.config.search?.provider || 'aggregator'
        });
        if (this.config.ui?.agent_debug_logs && (agentResult.warning || agentResult.error)) {
          console.info('[agent]', agentResult.warning || agentResult.error);
        }
        syncMsg(true);
        this.persist();
        this.focusArtifact(targetChatId, assistantMessage.id, agentResult.artifact);
      } else {
        await streamAssistantReply({
          messages: outboundMessages,
          signal: controller.signal,
          apiKey: activeProviderApiKey,
          reasoningLevel: activeReasoningLevel,
          sampling: turn.sampling,
          stop: turn.stop,
          onChunk: (value) => {
            reasoningTimer.markStopped();
            turn.record(value);
            appendStreamingContent(
              assistantMessage,
              value,
              assistantMessage.reasoning || '',
              assistantMessage.metadata,
              turn.sanitize
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
      turn.finalize(assistantMessage);
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
      snapshotVersion();
      if (assistantMessage.agentSteps?.length) {
        assistantMessage.agentSteps = settleAgentSteps(assistantMessage.agentSteps, assistantMessage.metadata);
      }

      const responseSources = (assistantMessage.sources || []) as SearchResult[];
      if (responseSources.length > 0) {
        this.queueWebAnswerRagIngest({
          chatId: targetChatId,
          query: content,
          answer: assistantMessage.content,
          sources: responseSources
        });
      }

      syncMsg(true);
      this.persist();

      if (this.config.tts?.enable_voice_output && this.config.tts?.auto_play_voice && assistantMessage.content
        && (activeContextMode !== 'roleplay' || roleplayStore.settings(targetChat).voicePlayback !== false)) {
        try {
          if (activeContextMode === 'roleplay') ttsStore.speakSequence(messageSpeechParts(assistantMessage, charactersStore.characters, this.config));
          else void ttsStore.speak(assistantMessage.id, assistantMessage.content, this.config);
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
      const timing = (Date.now() - startTime) / 1000;
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
      snapshotVersion();
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
      if (turn.sanitize) {
        assistantMessage.content = turn.sanitize(assistantMessage.content);
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
      roleplayStore.continueAuto(targetChatId, controller.signal.aborted || assistantMessage.status === 'error');
      roleplayStore.afterTurn(targetChatId, controller.signal.aborted || assistantMessage.status === 'error');
    }
  }

  /** Show a run's artifact when its chat is on screen and the studio follows this message. */
  private focusArtifact(chatId: string, messageId: string, artifact: AgentArtifact | null | undefined) {
    if (this.currentChatId === chatId && (artifact || this.currentArtifactMessageId === messageId)) {
      this.setCurrentArtifact(artifact ?? null, messageId);
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

  /** One non-streamed completion on the active model (roleplay drafts and summaries). */
  async completeText(messages: RequestMessage[]): Promise<string> {
    const result = await completeAssistantReply({ apiKey: this.activeProvider?.api_key, messages });
    return result.content || '';
  }

  get contextRatio(): number {
    return (this.contextBudget?.usagePercent ?? 0) / 100;
  }

  /** Roleplay "Continue": the last reply keeps going, streamed onto the same message. */
  /** The reply "Continue" can extend: the last one in the current roleplay scene, with text. */
  private continuable(messageId: string) {
    const chat = this.currentChat;
    const message = chat?.messages.at(-1);
    const ok = chat?.contextMode === 'roleplay' && message?.id === messageId && message.role === 'assistant' && !!message.content.trim();
    return ok && this.currentChatId ? { chat: chat!, message: message!, index: chat!.messages.length - 1, targetChatId: this.currentChatId } : null;
  }

  async continueMessage(messageId: string) {
    const target = this.continuable(messageId);
    if (!target) return;
    const { chat, message, index, targetChatId } = target;
    const activeBackendMode = this.backendMode as GenerationBackendMode;
    const activeProvider = this.activeProvider;
    if (!this.canStartGeneration({ backendMode: activeBackendMode, targetChatId, activeProvider, localBusyActionText: 'continuing here' })) return;

    const snapshot = message.versions?.[message.activeVersion ?? 0]?.metadata?.roleplay ?? message.metadata?.roleplay;
    const turn = roleplayStore.prepareTurn(chat, { speakerId: message.speakerId, snapshot, historyEnd: index });
    const history = buildRequestMessagesFromHistory(chat.messages, index, roleplayStore.attribution(chat, message.speakerId));
    const prefix = message.content;
    const version = message.versions?.[message.activeVersion ?? 0];
    const controller = new AbortController();
    let added = '';
    message.done = false;
    message.status = 'streaming';
    this.touchChats();
    try {
      this.beginGenerationRun(targetChatId, { controller, messageId: message.id, backendMode: activeBackendMode, mode: 'chat', startedAt: Date.now() });
      const systemPrompt = this.buildSystemPromptForMode({ backendMode: activeBackendMode, providerPrompt: activeProvider?.system_prompt, chat, speakerId: turn.speakerId, roleplaySnapshot: { roleplay: snapshot } });
      await streamAssistantReply({
        messages: [...turn.decorate(buildOutboundMessages({ messages: history, systemPrompt })), { role: 'system', content: CONTINUE_INSTRUCTION }],
        signal: controller.signal,
        apiKey: activeProvider?.api_key,
        reasoningLevel: chat.reasoningLevel ?? this.reasoningLevel,
        sampling: turn.sampling,
        stop: turn.stop,
        onChunk: (value) => {
          added += value;
          const tail = turn.sanitize ? turn.sanitize(added) : added;
          message.content = joinContinuation(prefix, tail);
          if (version) version.content = message.content;
          this.touchChats();
        }
      });
    } catch (error) {
      const failure = toErrorMessage(error) || 'Request failed';
      if (!isAbortLikeError(failure)) this.error = failure;
    } finally {
      message.done = true;
      message.status = 'idle';
      this.endGenerationRun(targetChatId, controller);
      this.touchChats();
      this.persist();
    }
  }

  async regenerateMessage(messageId: string, options: { reroll?: boolean } = {}) {
    const chat = this.currentChat;
    const targetChatId = this.currentChatId;
    if (!chat || !targetChatId) return;
    const index = chat.messages.findIndex((entry) => entry.id === messageId);
    const message = index >= 0 ? chat.messages[index] : null;
    if (!message || message.role !== 'assistant') return;

    const previousMessages = buildRequestMessagesFromHistory(
      chat.messages,
      index - 1,
      roleplayStore.attribution(chat, message.speakerId)
    );
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
    // An earlier Roleplay beat can't be rewritten under the turns that followed it.
    const later = chat.messages.length - index - 1;
    if (chat.contextMode === 'roleplay' && later > 0) {
      const t = get(translate);
      const ok = await confirmStore.ask({
        title: t('roleplay.regenerateEarlier.title'),
        message: t('roleplay.regenerateEarlier.message', { values: { n: later } }),
        confirmLabel: t('roleplay.regenerateEarlier.confirm'),
        danger: true
      });
      if (!ok || this.currentChatId !== targetChatId) return;
      chat.messages = chat.messages.slice(0, index + 1);
    }

    // A regenerate answers as the same speaker and keeps a forced next speaker.
    const currentSnapshot = message.versions?.[message.activeVersion ?? 0]?.metadata?.roleplay ?? message.metadata?.roleplay;
    const turn = roleplayStore.prepareTurn(chat, { speakerId: message.speakerId, snapshot: currentSnapshot, historyEnd: index, reroll: options.reroll });
    const agentic = message.mode === 'agent' || message.mode === 'instant';
    /*
     * The original turn's plan is carried over: an Instant answer stays on the
     * Instant fast path, and a Deep or Max research answer re-runs at the same
     * depth instead of silently shrinking to a plain chat agent.
     */
    const plan = planHomeAgentRun({ composerMode: message.mode, searchMode: message.searchMode });
    const regenPrompt = [...chat.messages.slice(0, index)].reverse().find((entry) => entry.role === 'user')?.content || '';

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
        ...(turn.snapshot ? { roleplay: turn.snapshot } : {}),
        ...executionMetadata(activeBackendMode)
      }
    };
    /** Keep the new version in step with what the message shows. */
    const mirrorVersion = () => {
      nextVersion.content = message.content;
      nextVersion.reasoning = message.reasoning;
      const { currentActivity, activityLabel: label } = message.metadata || {};
      if (currentActivity) nextVersion.metadata = { ...(nextVersion.metadata || {}), currentActivity, activityLabel: label };
    };

    // A reply that never recorded its first version keeps it as version 1.
    if (!message.versions?.length && message.content) {
      message.versions = [{ content: message.content, reasoning: message.reasoning || '', createdAt: message.createdAt, metadata: message.metadata }];
    }
    message.versions = [...(message.versions || []), nextVersion];
    message.activeVersion = message.versions.length - 1;
    // Same optimistic ack as a fresh send: intent confirmation now, replaced
    // wholesale by the engine's first content.
    message.content = agentic ? optimisticAck(regenPrompt, message.mode === 'agent' ? 'work' : 'lookup') : '';
    message.reasoning = '';
    message.done = false;
    message.status = 'streaming';
    if (agentic) {
      const initial = initialHomeActivity(plan, message.mode);
      message.agentSteps = [
        { id: createId('step'), type: 'thinking', label: activityLabel(initial.activity), status: 'running', detail: initial.detail }
      ];
      message.metadata = {
        ...(message.metadata || {}),
        modelName: activeModelLabel,
        ...executionMetadata(activeBackendMode),
        currentActivity: initial.activity,
        activityLabel: activityLabel(initial.activity)
      };
      mirrorVersion();
      message.artifact = null;
      message.artifacts = [];
      if (this.currentArtifactMessageId === message.id) {
        this.setCurrentArtifact(null, message.id, false);
      }
    }
    this.touchChats();

    /*
     * The run begins inside the `try` so the `finally` that ends it always runs.
     * `persist()` writes localStorage synchronously; a quota error before the
     * `try` recorded a run that could never be ended.
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
      const systemPrompt = this.buildSystemPromptForMode({
        backendMode: activeBackendMode,
        providerPrompt: activeProvider?.system_prompt,
        chat,
        speakerId: turn.speakerId,
        roleplaySnapshot: { roleplay: turn.snapshot }
      });
      const reasoningLevel = chat.reasoningLevel ?? this.reasoningLevel;
      if (agentic) {
        const agentResult = await runAgentTask({
          chatId: targetChatId,
          systemPrompt,
          messages: previousMessages,
          rawPrompt: regenPrompt,
          executionMode: 'sandbox',
          toolMode: plan.toolMode,
          agentProfile: plan.agentProfile,
          searchMode: plan.searchMode,
          quietActivity: plan.instant,
          conversationContext: this.buildSearchConversationContext(message.id, targetChatId),
          reasoningLevel,
          ...plan.budget,
          signal: controller.signal,
          ...homeAgentCallbacks({
            message,
            quiet: plan.instant,
            sync: () => {
              mirrorVersion();
              this.touchChats();
            },
            persist: () => this.persist(),
            onReasoningStart: () => reasoningTimer.markStarted(),
            onArtifacts: (latest) => this.focusArtifact(targetChatId, message.id, latest)
          })
        });
        exactUsage = agentResult.usage || exactUsage;
        markAgentWriting(message);
        mirrorVersion();
        this.touchChats();
        this.persist();
        applyHomeAgentResult(message, agentResult, {
          modelName: activeModelLabel,
          backendMode: activeBackendMode,
          searchMode: plan.searchMode,
          requestedProvider: this.config.search?.provider || 'aggregator'
        });
        nextVersion.content = message.content;
        nextVersion.reasoning = message.reasoning;
        nextVersion.metadata = message.metadata;
        this.focusArtifact(targetChatId, message.id, agentResult.artifact);
        this.touchChats();
        this.persist();
      } else {
        await streamAssistantReply({
          messages: turn.decorate(buildOutboundMessages({ messages: previousMessages, systemPrompt })),
          signal: controller.signal,
          apiKey: activeProvider?.api_key,
          reasoningLevel,
          sampling: turn.sampling,
          stop: turn.stop,
          onChunk: (value) => {
            reasoningTimer.markStopped();
            turn.record(value);
            const nextContent = nextVersion.content + value;
            nextVersion.content = turn.sanitize ? turn.sanitize(nextContent) : nextContent;
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
      message.content = nextVersion.content;
      message.metadata = nextVersion.metadata;
      turn.finalize(message);
      nextVersion.content = message.content;
      nextVersion.metadata = message.metadata;
      message.model = activeModelLabel;
      message.done = true;
      // Only set status to 'idle' if the agent result didn't already set 'error'
      // (it mutates the message, so TS still sees the 'streaming' assignment).
      if ((message.status as ChatMessage['status']) !== 'error') {
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
        message.agentSteps = settleAgentSteps(message.agentSteps, message.metadata);
      }
      this.touchChats();
      this.persist();
    } catch (error) {
      const timing = (Date.now() - startTime) / 1000;
      const failure = toErrorMessage(error) || 'Request failed';
      const aborted = isAbortLikeError(failure);
      nextVersion.content = aborted ? (nextVersion.content || '') : (nextVersion.content || failure);
      nextVersion.metadata = finalizeAssistantMetadata({
        existing: nextVersion.metadata,
        modelName: activeModelLabel,
        backendMode: activeBackendMode,
        elapsedSeconds: timing,
        totalElapsedSeconds: timing,
        reasoningElapsedSeconds: reasoningTimer.elapsedSeconds(),
        overrides: aborted ? {} : { error: true, errorMessage: failure }
      });
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
    if (chat.contextMode === 'roleplay') {
      const version = message.versions[next];
      const snapshot = version.metadata?.roleplay;
      message.content = version.content;
      message.metadata = version.metadata;
      message.choices = snapshot?.choices;
      message.props = snapshot?.props;
      message.storyTurn = snapshot?.storyTurn;
    }
    this.touchChats();
    this.persist();
  }

  /** "Branch from here": a new conversation with this one's turns up to and including `messageId`. */
  branchFromMessage(messageId: string) {
    const chat = this.currentChat;
    if (!chat) return;
    const keep = chat.messages.findIndex((entry) => entry.id === messageId) + 1;
    if (keep <= 0) return;
    const ids = new Map<string, string>([[chat.id, createId('chat')]]);
    for (const message of chat.messages) {
      ids.set(message.id, createId('msg'));
      for (const attachment of message.attachments ?? []) ids.set(attachment.id, createId('attachment'));
    }
    const branch = JSON.parse(JSON.stringify(chat), (_key, value) => typeof value === 'string' ? ids.get(value) ?? value : value) as ChatSession;
    branch.messages = branch.messages.slice(0, keep);
    branch.title = get(translate)('thread.branchTitle', { values: { title: chat.title } });
    branch.createdAt = branch.updatedAt = Date.now();
    this.chats = [...this.chats, branch];
    this.selectChat(branch.id);
    this.persist();
  }

  private _apiModelsCacheKey(): string | null {
    const isLocal = this.config.llm?.backend_mode === 'local' && isElectron();
    if (isLocal) return null;
    const providerName = this.config.llm?.provider || DEFAULT_PROVIDER_ID;
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
    // Speech credentials are handed to main for encryption, then discarded here.
    for (const section of [this.config.tts, this.config.stt]) {
      for (const provider of Object.values(section?.providers ?? {})) {
        if (provider.api_key) { provider.has_api_key = true; delete provider.api_key; }
      }
    }
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

  /**
   * Chat with a running local instance (Models → Running → Use in chat):
   * local mode, that model, that instance's port. Pass null to clear it.
   */
  async useLocalInstance(instance: { name: string; path: string; base_url: string } | null) {
    if (!instance) {
      this.localModelActive = null;
      await this.updateLocalSettings({ base_url: 'http://127.0.0.1:11435/v1' });
      return;
    }
    const next = setLocalModelConfig(this.config, { name: instance.name, path: instance.path } as never);
    next.llm = { ...next.llm, local: { ...(next.llm?.local || {}), base_url: instance.base_url } };
    await this.commitConfig(next, {});
    this.localModelActive = { name: instance.name, path: instance.path, hasMmproj: false };
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
    return this.config.ui?.roleplay_enabled !== false;
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

  async updateTtsSettings(partial: Partial<NonNullable<AppConfig['tts']>>) {
    await this.commitConfig(mergeTtsSettingsConfig(this.config, partial));
  }

  async updateSttSettings(partial: Partial<NonNullable<AppConfig['stt']>>) {
    await this.commitConfig({ ...this.config, stt: { ...(this.config.stt ?? {}), ...partial } });
  }
}

export const appStore = new AppStore();
roleplayStore.bind(appStore);
