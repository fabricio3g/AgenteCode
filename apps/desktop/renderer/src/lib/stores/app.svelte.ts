import { ModelDiscoveryController } from './models/model-discovery.svelte';
import { ThinkingCapabilitiesController } from './models/thinking-capabilities.svelte';
import { ModelSettingsController, type ConfigCommitOptions } from './models/model-settings';
import type { AgentArtifact, AppConfig, Attachment, ChatContextMode, ChatFolder, ChatMessage, ChatSession, LocalThinkingMode, MessageVersion, QueuedPrompt, ModelOption, ReasoningCapabilities, ReasoningLevel, WorkspaceFile } from '$lib/types/chat';
import type { Attachment as CodeAttachment } from '$shared/agente-protocol.gen';
import { captureChatModel, configForChatModel, homeRuntimeMatchesModel } from './chat-model';
import { SPACES, normalizeSpace } from '$lib/spaces';
import { getSpaceForSession } from '$lib/features/shared/session-guards';
import { approvalsStore } from '$lib/stores/approvals.svelte';
import type { IndexedDocument, SearchResult } from '$lib/types/bridge';
import { countOf } from '$lib/utils/format';
import { runAgentTask } from '$lib/services/agent';
import { captureDesignTurnContext, runDesignTask } from '$lib/services/agent-design-runtime';
import { applyHomeAgentResult, homeAgentCallbacks, initialHomeActivity, planHomeAgentRun, settleAgentSteps } from '$lib/features/home/home-turn';
import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
import { messageSpeechParts } from '$lib/features/roleplay/roleplay-voice';
import { CONTINUE_INSTRUCTION, joinContinuation } from '$lib/features/roleplay/roleplay-steer';
import { roleplayReasoningLevel } from '$lib/features/roleplay/roleplay-settings';
import type { RoleplayTurn } from '$lib/features/roleplay/roleplay-turn';
import { charactersStore } from '$lib/features/roleplay/characters.svelte';
import { completionReserve, fitRoleplayRequest, FALLBACK_CONTEXT_TOKENS } from '$lib/services/roleplay-budget';
import { localRoleplaySampling, type RoleplaySampling } from '$lib/services/roleplay-prompts';
import { getSupervisorStatus } from '$lib/services/runtime';
import { resolveComposerRoute, shouldUseToolLoop } from '$lib/services/composer-route';
import { parseSlidesFromMarkdown } from '$lib/services/slides';
import { writeTempFile, pathExists, pickWorkspaceFolder as pickWorkspaceFolderDialog, indexWorkspaceFolder, createWorkspaceDocument, renameWorkspaceFile, deleteWorkspaceFile, readWorkspaceFile, openWorkspaceFile, createWorkspaceFolder } from '$lib/services/files';
import { ingestAttachment } from '$lib/services/attachment-ingestion';
import { INGESTED_DOCUMENT_GUIDANCE, ingestionFileType } from '$shared/document-ingestion';
import { clearRagDocuments, ingestDocument, ingestText, ingestTextFast, listRagDocuments, queryDocuments, removeRagDocument } from '$lib/services/rag';
import { webSearch } from '$lib/services/search';
import { getRecommendedSettings, loadLocalModel, onSupervisorEvent, stopLlama } from '$lib/services/runtime';
import { invoke, isElectron } from '$lib/services/bridge';
import { checkIsFirstRun } from '$lib/services/onboarding';
import { downloadsStore } from '$lib/stores/downloads.svelte';
import { deepResearchStore } from '$lib/stores/deep-research.svelte';
import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
import { modelsStore } from '$lib/stores/models.svelte';
import { ttsStore } from '$lib/stores/tts.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { confirmStore } from '$lib/stores/confirm.svelte';
import { get } from 'svelte/store';
import { _ as translate } from 'svelte-i18n';
import type { CompletionResult, RequestMessage } from '$lib/services/chat/types';
import { cachedModels, completeAssistantReply, detectToolSupport, fetchModels, fetchReasoningCapabilities, hasConfiguredVisionModel, invalidateModels, loadChatConfig, reasoningRouteIdentity, streamAssistantReply } from '$lib/services/chat-api';
import { loadChatState, saveChatState, saveAppConfig, saveChatDraftToDb, saveChatStateToDb, loadChatStateFromDb, deleteChatFromDb } from '$lib/utils/storage';
import { toErrorMessage } from '$lib/utils/errors';
import { describeLocalLoadError } from '$lib/utils/local-load-errors';
import { estimateContextBreakdown, homeRuntimeBudget } from '$lib/stores/app-context-budget';
import type { RunAgentTaskArgs } from '$lib/services/agent-types';
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
import { inferContextWindowFromModel } from '$lib/stores/app-context-budget';
import {
  mergePromptSettingsConfig,
  mergeSearchSettingsConfig,
  mergeTtsSettingsConfig,
  mergeUiSettingsConfig,
  setLocalModelConfig,
  type ProviderUpdate,
  type LocalSettingsUpdate,
} from '$lib/stores/app-store-config';
import { findLatestArtifactMessage, removeArtifactFromMessage, resolveArtifactForMessage, upsertArtifactOnMessage } from '$lib/stores/app-store-artifacts';
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
  type ElectronApi,
  dropFailedReplies,
  isFailedReply
} from '$lib/stores/app-store-helpers';
import { DEFAULT_PROVIDER_ID } from '$shared/providers';
import { loadProviderDirectory } from '$lib/utils/provider-directory.svelte';

class AppStore {
  ready = $state(false);
  private globalConfig = $state<AppConfig>({});

  get config(): AppConfig {
    return configForChatModel(this.globalConfig, this.currentChat?.modelSelection);
  }

  set config(value: AppConfig) {
    this.globalConfig = value;
  }

  configForChat(chat: ChatSession): AppConfig {
    return configForChatModel(this.globalConfig, chat.modelSelection);
  }
  chats = $state<ChatSession[]>([]);
  folders = $state<ChatFolder[]>([]);
  currentChatId = $state<string | null>(null);
  activeSpace = $state<ChatContextMode>('home');
  currentChatIdBySpace = $state<Record<ChatContextMode, string | null>>({ home: null, code: null, roleplay: null, design: null });
  composer = $state('');
  private readonly modelDiscovery = new ModelDiscoveryController({
    getConfig: () => this.config,
    isNative: isElectron,
    cached: cachedModels,
    fetch: (config, force) => fetchModels(config, undefined, force),
    loadLocal: async () => {
      await modelsStore.refreshIndex();
      return Promise.all(modelsStore.availableModels.map(async model =>
        buildLocalModelOption(model, !!(model.path && await this.detectMmprojForModel(model.path)))
      ));
    }
  });
  get models() { return this.modelDiscovery.models; }
  set models(value: ModelOption[]) { this.modelDiscovery.models = value; }
  get modelsRefreshing() { return this.modelDiscovery.refreshing; }
  set modelsRefreshing(value: boolean) { this.modelDiscovery.refreshing = value; }

  private readonly modelSettings = new ModelSettingsController({
    getConfig: () => this.config,
    isNative: isElectron,
    commit: (config, options) => this.commitConfig(config, options)
  });
  modelMenuOpen = $state(false);
  /** Legacy: something outside the renderer asks for Settings; AppShell maps it to a section. */
  settingsOpen = $state(false);
  promptConfigOpen = $state(false);
  /**
   * The Settings screen: a surface over the current space, not a modal. The
   * conversation stays mounted underneath it, so a trip to Settings costs no
   * scroll position and no streaming turn.
   */
  settingsScreenOpen = $state(false);
  /** Section to open at (`'general'`, `'providers'`, `'runtime'`, …); null keeps the last one. */
  settingsScreenSection = $state<string | null>(null);
  runtimeManagerOpen = $state(false);
  agentWorkspaceOpen = $state(false);
  artifactStudioOpen = $state(false);
  /** What the Home surface shows: the chat, or the Artifacts screen. */
  homeView = $state<'chat' | 'artifacts' | 'files'>('chat');
  /** Open or close search within the current space. */
  openSearch(): void {
    this.chatSearchOpen = !this.chatSearchOpen;
  }

  get activeTab(): ChatContextMode {
    return this.activeSpace;
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
  private readonly thinkingCapabilities = new ThinkingCapabilitiesController({
    getConfig: () => this.config,
    isNative: isElectron,
    fetch: fetchReasoningCapabilities,
    onResolved: capabilities => {
      if (!capabilities.supported || (this.reasoningLevel && !capabilities.levels.includes(this.reasoningLevel))) this.setReasoningLevel(null);
    }
  });
  get reasoningCapabilities() { return this.thinkingCapabilities.capabilities; }
  set reasoningCapabilities(value: ReasoningCapabilities) { this.thinkingCapabilities.capabilities = value; }
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
  localModelLoadKeepInMemory = $state(false);
  localModelLoadMmap = $state(true);
  localModelLoadSeed = $state('');
  localModelLoadParallel = $state('1');
  /** A load started from the model menu runs without its dialog; a failure brings the dialog back. */
  localModelLoadQuiet = $state(false);
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
    // The clock starts with the run, so work can be told from silence before
    // the first event lands.
    this.activeRunsByChat = {
      ...this.activeRunsByChat,
      [chatId]: { lastEventAt: Date.now(), ...run }
    };
    this.refreshGenerationState();
  }

  /** An event just arrived for this chat's run: the meter reads this as "alive". */
  private touchRun(chatId: string) {
    const run = this.activeRunsByChat[chatId];
    if (run) run.lastEventAt = Date.now();
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

  /** Design sessions only. */
  get visibleDesignChats() {
    return this.getSessionsForSpace('design');
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

  private homeRuntimeArgs(chat: ChatSession, message: ChatMessage, historyIds: string[]): Pick<RunAgentTaskArgs, 'config' | 'homeRuntime' | 'historyIds' | 'onRuntime' | 'onConversationIndex'> {
    return {
      config: this.configForChat(chat),
      homeRuntime: chat.homeRuntime,
      historyIds,
      onRuntime: (meta) => {
        // The model sees history only through this answer. Later edits force a fresh import.
        chat.homeRuntime = { ...meta, historyIds: [...historyIds, message.id] };
        if (this.currentChatId === chat.id && homeRuntimeMatchesModel(meta, this.config)) {
          ++this.contextBudgetRequestId;
          this.contextBudget = homeRuntimeBudget(meta, this.composer.trim()) || this.contextBudget;
        }
        this.touchChats(chat.id);
        this.persist();
      },
      onConversationIndex: (index, sessionId, revision) => {
        message.metadata = { ...message.metadata, homeConversationIndex: index, homeSessionId: sessionId, homeRevision: revision };
        this.markChatDirty(chat.id);
        this.persist();
      }
    };
  }

  async refreshContextBudgetPreview() {
    const requestId = ++this.contextBudgetRequestId;
    if (!isElectron() || typeof window === 'undefined' || !window.electronAPI?.invoke) {
      this.contextBudget = null;
      return;
    }

    const chat = this.currentChat;
    if (!chat) {
      this.contextBudget = null;
      return;
    }

    const runtime = chat.homeRuntime;
    if (runtime && homeRuntimeMatchesModel(runtime, this.config)) {
      const budget = homeRuntimeBudget(runtime, this.composer.trim());
      if (budget) { this.contextBudget = budget; return; }
    }

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
      this.contextBudget = budget ? { ...budget, estimated: true, breakdown: estimateContextBreakdown(outboundMessages) } : this.contextBudget;
    } catch {
      // Keep the last reading when token counting is temporarily unavailable.
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
    const voicePrompt = this.voiceModeActive && chat?.id === this.currentChatId
      ? (chat?.composerMode === 'instant'
        ? '\n\nThis is a live voice conversation in Instant mode. Talk naturally in short sentences. Answer directly without tools or background work. Be honest when current information cannot be verified.'
        : '\n\nThis is a live voice conversation. Reply in short, natural spoken sentences. Give a brief useful update before background searches and return findings as they arrive. Keep tool calls out of spoken text. Use the available tools when the question needs verification; never invent progress or results.') : '';
    return buildSystemPrompt({
      basePrompt: basePrompt + voicePrompt,
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


  /**
   * Show the Settings screen, at `section` when one is named.
   *
   * A deep link only wins while the screen is closed: `Ctrl+,` inside Settings
   * is a toggle, so re-picking General would otherwise yank you out of Voice.
   */
  openSettings(section: string | null = null) {
    if (!this.settingsScreenOpen) this.settingsScreenSection = section;
    this.settingsScreenOpen = true;
  }

  /** Leave Settings for whatever was underneath it. */
  closeSettings() {
    this.settingsScreenOpen = false;
  }

  /** Show the Artifacts library. */
  showArtifactLibrary() {
    this.artifactScreenKey = null;
    this.artifactReturnChatId = null;
    this.homeView = 'artifacts';
  }

  /** Show the Files library: uploads and the documents the Code agent made, across every chat. */
  showFileLibrary() {
    this.homeView = 'files';
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

  /**
   * Delete one artifact everywhere it shows: its message, the side panel, the
   * full-screen view and the studio. Positions after it shift down, so any open
   * view of the same message is closed rather than left pointing at a neighbour.
   */
  deleteArtifact(chatId: string, messageId: string, index: number): boolean {
    const chat = this.findChat(chatId);
    if (!removeArtifactFromMessage(chat, messageId, index)) return false;

    if (this.artifactPanels[chatId]?.messageId === messageId) {
      const next = { ...this.artifactPanels };
      delete next[chatId];
      this.artifactPanels = next;
    }
    if (this.artifactScreenKey?.startsWith(`${chatId}:${messageId}:`)) {
      this.artifactScreenKey = null;
    }
    if (this.currentChatId === chatId && this.currentArtifactMessageId === messageId) {
      this.currentArtifact = null;
      this.currentArtifactMessageId = null;
      this.artifactStudioOpen = false;
    }

    this.markChatDirty(chatId);
    this.touchChats(chatId);
    this.persist();
    return true;
  }

  /**
   * Delete a file the user attached in a Home chat: it leaves its message and,
   * unless another message of the chat still carries the same indexed document
   * (re-uploads share one), its knowledge-base entry.
   */
  async deleteUpload(chatId: string, messageId: string, attachmentId: string): Promise<boolean> {
    const chat = this.findChat(chatId);
    const message = chat?.messages.find((entry) => entry.id === messageId);
    const attachment = message?.attachments?.find((entry) => entry.id === attachmentId);
    if (!chat || !message || !attachment) return false;

    message.attachments = message.attachments!.filter((entry) => entry.id !== attachmentId);
    if (attachment.preview?.startsWith('blob:')) URL.revokeObjectURL(attachment.preview);

    const docStillUsed = !!attachment.docId && chat.messages.some((entry) =>
      entry.attachments?.some((other) => other.docId === attachment.docId));
    if (attachment.docId && !docStillUsed && isElectron()) {
      await removeRagDocument(attachment.docId, chatId).catch(() => {});
      this.refreshRagDocuments(chatId).catch(() => {});
    }

    this.markChatDirty(chatId);
    this.touchChats(chatId);
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

  /** Load with the remembered/recommended settings and no dialog (the model menu's path). */
  async loadLocalModelQuietly(model: LocalModelLoadTarget) {
    this.localModelLoadQuiet = true;
    try {
      await this.openLocalModelLoadDialog(model);
      await this.confirmLocalModelLoad();
    } finally {
      this.localModelLoadQuiet = false;
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
    // The provider directory comes from the core; nothing waits on it.
    void loadProviderDirectory();

    try {
      const CONFIG_TIMEOUT_SENTINEL = Symbol('timeout');
      // Config and the chat database are independent: load them side by side.
      const dbLoad = loadChatStateFromDb();
      const configResult = await withTimeout<AppConfig | typeof CONFIG_TIMEOUT_SENTINEL>(loadChatConfig(), 5000, CONFIG_TIMEOUT_SENTINEL);
      if (configResult === CONFIG_TIMEOUT_SENTINEL) {
        console.warn('[appStore.init] Config load timed out after 5s — using empty config fallback. Backend mode will default to local.');
        this.config = {};
      } else {
        this.config = configResult;
      }
      // In Electron: load from SQLite (primary). Falls back to localStorage migration.
      const dbResult = await dbLoad;
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

      // A space that is switched off leaves nothing behind: a window restored
      // into Roleplay opens Home instead, and its scene is not carried over.
      if (!this.spaceEnabled(this.activeSpace)) this.activeSpace = 'home';
      if (this.currentChat && !this.spaceEnabled(normalizeContextMode(this.currentChat.contextMode))) {
        this.currentChatId = null;
      }

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

  persist({ navigationOnly = false }: { navigationOnly?: boolean } = {}) {
    saveChatState<PersistedState>({
      chats: this.chats,
      folders: this.folders,
      currentChatId: this.currentChatId,
      activeSpace: this.activeSpace,
      currentChatIdBySpace: this.currentChatIdBySpace
    });
    // Flush current, generating, and any explicitly dirty chats to SQLite.
    const chatIds = new Set<string>(this.dirtyChatIds);
    if (!navigationOnly) {
      if (this.currentChatId) chatIds.add(this.currentChatId);
      for (const chatId of Object.keys(this.activeRunsByChat)) chatIds.add(chatId);
    }

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
      roleplay: typeof raw.roleplay === 'string' ? raw.roleplay : null,
      design: typeof raw.design === 'string' ? raw.design : null
    };
  }

  private defaultTitleForMode(mode: ChatContextMode) {
    if (mode === 'code') return 'New session';
    if (mode === 'roleplay') return 'New roleplay';
    if (mode === 'design') return 'New design';
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
    const previousModel = chat.modelSelection;
    const previousSearchMode = chat.searchMode;
    const previousComposerMode = chat.composerMode;
    chat.modelSelection ??= captureChatModel(this.globalConfig, this.backendMode);
    const mode = normalizeContextMode(chat.contextMode);
    this.composer = chat.draft || '';
    this.searchMode = mode === 'roleplay' ? 'chat' : normalizeSessionSearchMode(chat.searchMode);
    this.composerMode = normalizeSessionComposerMode(chat.composerMode, mode);
    this.reasoningLevel = chat.reasoningLevel ?? null;
    // Keep session fields canonical after hydrate
    chat.searchMode = this.searchMode;
    chat.composerMode = this.composerMode;
    if (!previousModel || previousSearchMode !== chat.searchMode || previousComposerMode !== chat.composerMode) this.markChatDirty(chat.id);

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
   * Give a space something to show. Home gets a fresh chat. Code and Roleplay
   * do not: a Code conversation is created inside a project, and a Roleplay
   * scene starts from the library, so an empty space shows its landing page
   * instead of an invisible stray chat.
   */
  private ensureChatForSpace(mode: ChatContextMode) {
    const normalized = normalizeContextMode(mode);
    if (normalized !== 'code' && normalized !== 'roleplay') {
      this.createChat(mode);
      return;
    }
    this.currentChatId = null;
    this.hydrateUiFromChat(null);
  }

  /**
   * Roleplay's "New roleplay": the library, with no chat created. A scene is
   * made when a character or a setup is started, so this never leaves an
   * empty "New roleplay" row behind.
   */
  /** Bumped by `startRoleplayScene`; the roleplay surface opens scene setup when it changes. */
  roleplaySceneRequest = $state(0);

  /** The space's "New": go to the library and open scene setup there. */
  startRoleplayScene() {
    if (!this.roleplayEnabled) return;
    this.openRoleplayLibrary();
    this.roleplaySceneRequest += 1;
  }

  openRoleplayLibrary() {
    if (!this.roleplayEnabled) return;
    this.settingsScreenOpen = false;
    this.homeView = 'chat';
    if (this.currentChat) {
      const currentMode = normalizeContextMode(this.currentChat.contextMode);
      this.currentChatIdBySpace = { ...this.currentChatIdBySpace, [currentMode]: this.currentChat.id };
    }
    this.activeSpace = 'roleplay';
    this.currentChatIdBySpace = { ...this.currentChatIdBySpace, roleplay: null };
    this.currentChatId = null;
    this.hydrateUiFromChat(null);
    this.persist();
  }

  private rebuildChatIdBySpace() {
    const next: Record<ChatContextMode, string | null> = { home: null, code: null, roleplay: null, design: null };
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
    // Settings → General is the only door into an opt-in space.
    if (!this.spaceEnabled(nextMode)) return;
    this.settingsScreenOpen = false;
    this.homeView = 'chat';
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
    this.settingsScreenOpen = false;
    this.homeView = 'chat';
    const contextMode = normalizeContextMode(mode);
    const chat = this.newChatSession(contextMode, options.workspace);
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

  /** A fresh, unsaved conversation for a space, with this app's model. */
  private newChatSession(contextMode: ChatContextMode, workspace?: ChatSession['workspace']): ChatSession {
    const now = Date.now();
    return {
      id: createId('chat'),
      title: this.defaultTitleForMode(contextMode),
      createdAt: now,
      updatedAt: now,
      folderId: null,
      draft: '',
      contextMode,
      codeAgent: null,
      projectId: null,
      workspace: contextMode === 'code' ? (workspace || null) : null,
      modelSelection: captureChatModel(this.config, this.backendMode),
      reasoningLevel: null,
      composerMode: this.defaultComposerModeFor(contextMode),
      searchMode: 'chat',
      characterId: null,
      worldId: null,
      personaId: null,
      greetingIndex: 0,
      roleplay: contextMode === 'roleplay' ? {} : null,
      messages: []
    };
  }

  /**
   * A Home conversation started from the browser extension's chat panel.
   * Unlike createChat it leaves the window where it is: the person is
   * working in their browser, not here.
   */
  createBrowserChat(title?: string) {
    const chat: ChatSession = { ...this.newChatSession('home'), origin: 'browser' };
    if (title?.trim()) chat.title = title.trim().slice(0, 80);
    this.chats = [chat, ...this.chats];
    this.markChatDirty(chat.id);
    this.persist();
    return chat;
  }

  selectChat(chatId: string) {
    this.settingsScreenOpen = false;
    const previousRoute = reasoningRouteIdentity(this.config);
    this.homeView = 'chat';
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
    ++this.contextBudgetRequestId;
    this.contextBudget = null;
    this.refreshGenerationState();
    // Restore per-chat UI slice (modes, draft, panels) — never rewrite contextMode
    this.hydrateUiFromChat(match);
    if (previousRoute !== reasoningRouteIdentity(this.config) || !this.models.length) void this.refreshModels();
    void this.refreshReasoningCapabilities();
    this.persist({ navigationOnly: true });
    if (isElectron()) {
      void this.refreshRagDocuments(chatId);
    }
  }

  updateComposer(value: string) {
    this.composer = value;
    if (this.currentChatId && this.updateChatDraft(this.currentChatId, value)) this.persistDraft(this.currentChatId);
  }

  persistDraft(chatId: string) {
    const chat = this.findChat(chatId);
    if (!chat) return;
    if (isElectron()) {
      void saveChatDraftToDb(chat).catch(error => {
        console.error('[draft] Save failed:', error);
      });
    } else this.persist();
  }

  queuePrompt(chatId: string, content: string, media: Pick<QueuedPrompt, 'attachments' | 'codeAttachments'> = {}): QueuedPrompt | null {
    const chat = this.findChat(chatId);
    if (!chat || !content.trim()) return null;
    const item: QueuedPrompt = { id: createId('queued'), content: content.trim(), ...media };
    chat.pendingPrompts = [...(chat.pendingPrompts ?? []), item];
    this.persistDraft(chatId);
    return chat.pendingPrompts.at(-1)!;
  }

  updateQueuedPrompt(chatId: string, id: string, content: string): void {
    const item = this.findChat(chatId)?.pendingPrompts?.find(item => item.id === id && !item.sending);
    if (!item || !content.trim()) return;
    item.content = content.trim();
    this.persistDraft(chatId);
  }

  removeQueuedPrompt(chatId: string, id: string): QueuedPrompt | undefined {
    const chat = this.findChat(chatId);
    const item = chat?.pendingPrompts?.find(item => item.id === id && !item.sending);
    if (!chat || !item) return;
    chat.pendingPrompts = chat.pendingPrompts!.filter(entry => entry.id !== id);
    this.persistDraft(chatId);
    return item;
  }

  private voiceSteering = new Map<string, Set<string>>();

  /** Voice interruption stops playback, while a running search keeps its turn. */
  async sendVoicePrompt(chatId: string, text: string): Promise<void> {
    const chat = this.findChat(chatId);
    if (!chat || !text.trim()) return;
    const item = this.queuePrompt(chatId, text);
    if (!item) return;
    if (this.isChatGenerating(chatId) && chat.homeRuntime?.sessionId) {
      const ids = this.voiceSteering.get(chatId) ?? new Set<string>();
      ids.add(item.id); this.voiceSteering.set(chatId, ids); item.sending = true;
      try {
        const result = await invoke<{ ok: boolean }>('home_runtime_steer', { sessionId: chat.homeRuntime.sessionId, content: text });
        if (result.ok) return;
      } catch { /* A turn may settle while transcription finishes. Keep the input queued. */ }
      ids.delete(item.id); item.sending = false;
    }
    if (!this.isChatGenerating(chatId)) void this.startNextQueuedPrompt(chatId);
  }

  private queuedContinuation = new Set<string>();

  async sendQueuedPromptsNow(chatId: string, id?: string): Promise<void> {
    const chat = this.findChat(chatId);
    if (!chat?.pendingPrompts?.length) return;
    // Chat sends one prompt per turn: the chosen one goes first.
    const chosen = id ? chat.pendingPrompts.find((item) => item.id === id && !item.sending) : undefined;
    if (chosen) chat.pendingPrompts = [chosen, ...chat.pendingPrompts.filter((item) => item !== chosen)];
    const run = this.activeRunsByChat[chatId];
    if (run) {
      this.queuedContinuation.add(chatId);
      // Let the run's finally finish saving its partial answer before starting
      // the queued turn. Do not release its slot early or abort another chat.
      run.controller.abort();
    } else await this.startNextQueuedPrompt(chatId);
  }

  private async startNextQueuedPrompt(chatId: string): Promise<void> {
    if (this.isChatGenerating(chatId)) return;
    const chat = this.findChat(chatId);
    const item = chat?.pendingPrompts?.find(item => !item.sending);
    if (!item) return;
    // Remove only when generation actually starts; an unavailable local model
    // or provider keeps the prompt editable instead of silently losing it.
    await this.sendCurrentMessage({ chatId, queuedPrompt: item });
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
    this.queuedContinuation.delete(chatId);
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

  /** Deletes every conversation in a space (the sidebar's "Clear history"); returns how many. */
  clearChatHistory(space: ChatContextMode = this.activeSpace): number {
    const ids = this.getSessionsForSpace(space).map((chat) => chat.id);
    for (const id of ids) this.deleteChat(id, { silent: true });
    return ids.length;
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
      if (chat.contextMode !== 'code' && chat.homeRuntime?.sessionId && this.isChatGenerating(chat.id)) {
        void invoke('home_runtime_update', { sessionId: chat.homeRuntime.sessionId, thinkingLevel: level || 'auto' }).catch(error => toastStore.error(String(error)));
      }
      this.touchChats();
      this.persist();
    }
  }

  refreshReasoningCapabilities(force = false) { return this.thinkingCapabilities.refresh(force); }

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

  private documentStillReferenced(chatId: string, docId: string): boolean {
    const chat = this.findChat(chatId);
    return (this.currentChatId === chatId && this.pendingAttachments.some((item) => item.docId === docId))
      || !!chat?.messages.some((message) => message.attachments?.some((item) => item.docId === docId))
      || !!chat?.workspace?.files.some((file) => file.docId === docId);
  }

  removeAttachment(attachmentId: string) {
    const attachment = this.pendingAttachments.find((a) => a.id === attachmentId);
    this.pendingAttachments = this.pendingAttachments.filter((a) => a.id !== attachmentId);
    // If image, revoke the blob URL to free memory
    if (attachment?.preview?.startsWith('blob:')) {
      URL.revokeObjectURL(attachment.preview);
    }
    // If it's a RAG document, remove from backend too
    if (attachment?.docId && isElectron() && this.currentChatId && !this.documentStillReferenced(this.currentChatId, attachment.docId)) {
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

    const attachments: Attachment[] = files.map((file) => {
      const { kind, mime } = ingestionFileType(file.name, file.type);
      return {
        id: createId('attachment'), name: file.name, size: file.size, type: mime,
        kind: kind === 'image' ? 'image' : 'document', status: 'processing',
        processingMode: kind === 'audio' || kind === 'video' ? 'transcription' : kind === 'image' ? 'ocr' : 'document_text'
      };
    });
    // Publish before reading so progress/errors are visible and Enter cannot
    // send a draft while one of its files is still being extracted.
    this.pendingAttachments = [...this.pendingAttachments, ...attachments];
    const uploadConfig = this.configForChat(this.findChat(targetChatId)!);
    for (let i = 0; i < files.length; i++) {
      const result = await ingestAttachment(files[i], { ...attachments[i] }, targetChatId, {
        visionAvailable: () => hasConfiguredVisionModel(uploadConfig),
        dataUrl: readBlobAsDataUrl,
        writeFile: (name, bytes) => writeTempFile(`${Date.now()}_${name}`, bytes),
        ingest: ingestDocument,
        extractFallback: async (file) => (await import('$lib/services/ocr')).extractFileContent(file)
      });
      if (this.currentChatId === targetChatId) {
        // A removed processing chip must not leave hidden source context behind.
        if (!this.pendingAttachments.some((item) => item.id === result.id) && result.docId && !this.documentStillReferenced(targetChatId, result.docId)) {
          await removeRagDocument(result.docId, targetChatId);
        }
        // Publish ready only once the turn's document context has caught up.
        await this.refreshRagDocuments(targetChatId);
        this.pendingAttachments = this.pendingAttachments.map((item) => item.id === result.id ? result : item);
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

  private requireCurrentWorkspace(): { chatId: string; rootPath: string } {
    const chatId = this.currentChatId || '';
    const rootPath = this.findChat(chatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    return { chatId, rootPath };
  }

  /** Create a file inside the workspace from the UI */
  async createWorkspaceFile(relativePath: string, docType: string, content: string): Promise<string> {
    const { chatId, rootPath } = this.requireCurrentWorkspace();
    const fullPath = await createWorkspaceDocument(rootPath, relativePath, docType, content);
    await this.refreshWorkspace(chatId);
    return fullPath;
  }

  async renameWorkspaceFile(oldRelPath: string, newRelPath: string): Promise<void> {
    const { chatId, rootPath } = this.requireCurrentWorkspace();
    await renameWorkspaceFile(rootPath, oldRelPath, newRelPath);
    await this.refreshWorkspace(chatId);
    toastStore.info(`Renamed to ${newRelPath.split('/').pop()}`, 2000);
  }

  async deleteWorkspaceFile(relativePath: string): Promise<void> {
    const { chatId, rootPath } = this.requireCurrentWorkspace();
    await deleteWorkspaceFile(rootPath, relativePath);
    await this.refreshWorkspace(chatId);
    toastStore.info(`Deleted ${relativePath.split('/').pop()}`, 2000);
  }

  async readWorkspaceFile(relativePath: string): Promise<string> {
    const { rootPath } = this.requireCurrentWorkspace();
    return readWorkspaceFile(rootPath, relativePath);
  }

  async openWorkspaceFile(relativePath: string): Promise<void> {
    const { rootPath } = this.requireCurrentWorkspace();
    const fullPath = `${rootPath}/${relativePath}`;
    await openWorkspaceFile(fullPath, rootPath);
  }

  async createWorkspaceFolder(relativePath: string): Promise<void> {
    const { chatId, rootPath } = this.requireCurrentWorkspace();
    await createWorkspaceFolder(rootPath, relativePath);
    await this.refreshWorkspace(chatId);
    toastStore.info(`Folder created`, 2000);
  }

  private canStartGeneration(params: {
    backendMode: GenerationBackendMode;
    targetChatId: string;
    activeProvider?: { has_api_key?: boolean; api_key?: string; model?: string } | null;
    localBusyActionText?: string;
    selectedLocalModelPath?: string;
  }): boolean {
    return canStartGenerationHelper({
      ...params,
      selectedLocalModelPath: params.selectedLocalModelPath ?? this.selectedLocalModelPath,
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
  async sendCurrentMessage(options: { silent?: boolean; chatId?: string; queuedPrompt?: QueuedPrompt } = {}) {
    const silent = !!options.silent;
    const content = silent ? '' : (options.queuedPrompt?.content ?? this.composer).trim();
    const targetChatId = options.chatId ?? this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    if (!targetChat || !targetChatId) return;
    if (!silent && !content && !((options.queuedPrompt ? options.queuedPrompt.attachments ?? [] : this.pendingAttachments)).length) {
      await this.sendQueuedPromptsNow(targetChatId);
      return;
    }

    const inputAttachments = (options.queuedPrompt ? options.queuedPrompt.attachments ?? [] : this.pendingAttachments);
    if (!silent && inputAttachments.some((attachment) => attachment.status === 'processing')) {
      toastStore.info('Wait for the attached files to finish reading.', 2800);
      return;
    }
    if (!silent && inputAttachments.some((attachment) => attachment.status === 'error')) {
      toastStore.info('Remove files that could not be read before sending.', 2800);
      return;
    }
    if (!silent && this.isChatGenerating(targetChatId)) {
      if (content || inputAttachments.length) {
        this.queuePrompt(targetChatId, content || 'Please review the attached media.', { attachments: [...inputAttachments] });
        this.updateComposer('');
        this.pendingAttachments = [];
      } else await this.sendQueuedPromptsNow(targetChatId);
      return;
    }
    const selectedConfig = this.configForChat(targetChat);
    const selection = captureChatModel(selectedConfig, this.backendMode);
    const activeBackendMode = selection.backendMode as GenerationBackendMode;
    const activeModelLabel = activeBackendMode === 'local' ? selection.localModel : selection.model;
    const activeProvider = selectedConfig.llm?.providers?.[selection.provider];
    const activeProviderApiKey = activeProvider?.api_key;
    const activeContextMode = normalizeContextMode(targetChat.contextMode);
    const activeSearchMode = normalizeSessionSearchMode(targetChat.searchMode ?? this.searchMode);
    const activeComposerMode = normalizeSessionComposerMode(targetChat.composerMode ?? this.composerMode, activeContextMode);
    const activeReasoningLevel = activeContextMode === 'roleplay'
      ? this.roleplayThinking(targetChat, activeBackendMode)
      : targetChat.reasoningLevel ?? this.reasoningLevel;
    const targetRagDocuments = this.ragDocumentsByChat[targetChatId] || [];

    if (!this.canStartGeneration({
      backendMode: activeBackendMode,
      targetChatId,
      activeProvider,
      selectedLocalModelPath: selection.localModelPath
    })) return;

    this.error = null;
    const designContext = activeContextMode === 'design' ? captureDesignTurnContext(targetChatId) : undefined;
    const userMessage: ChatMessage | null = silent
      ? null
      : {
          id: createId('msg'),
          role: 'user',
          content,
          createdAt: Date.now(),
          done: true,
          status: 'idle',
          attachments: inputAttachments,
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
      if (options.queuedPrompt) {
        targetChat.pendingPrompts = targetChat.pendingPrompts?.filter(item => item.id !== options.queuedPrompt!.id);
        this.persistDraft(targetChatId);
      } else {
        this.composer = '';
        targetChat.draft = '';
      }
    }
    const sentAttachments = silent ? [] : [...inputAttachments];
    if (!silent && !options.queuedPrompt) this.pendingAttachments = [];

    const composerRoute = resolveComposerRoute({
      prompt: content,
      hasAttachments: sentAttachments.length > 0 || targetRagDocuments.length > 0,
      searchMode: activeSearchMode,
      contextMode: activeContextMode
    });
    const useToolLoop = shouldUseToolLoop({
      voiceCall: this.voiceModeActive && targetChatId === this.currentChatId,
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

      // Roleplay history reaches the model as the viewer reads it (macros resolved
      // per message, for this turn's persona); other chats pass through unchanged.
      const history = roleplayStore.resolveHistory(targetChat, targetChat.messages, { user: turn.attribution?.userName });
      // A failed reply is an error notice, never the character's words: the model does not read it back.
      const wireHistory = activeContextMode === 'roleplay' ? dropFailedReplies(history) : history;
      const requestMessages = userMessage
        ? buildRequestMessagesWithPatchedUser({
            messages: wireHistory,
            assistantMessageId: assistantMessage.id,
            userMessageId: userMessage.id,
            userContent: history.find((message) => message.id === userMessage.id)?.content ?? content,
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
            wireHistory,
            wireHistory.length - 1,
            turn.attribution
          );

      // A roleplay request is composed by its turn (stable block, history, volatile tail) and fitted to the window.
      const roleplayRequest = activeContextMode === 'roleplay'
        ? await this.roleplayRequest(turn, targetChat, requestMessages, activeBackendMode)
        : null;
      let systemPrompt = roleplayRequest ? '' : this.buildSystemPromptForMode({
        backendMode: activeBackendMode,
        providerPrompt: activeProvider?.system_prompt,
        includeChartHint: activeComposerMode !== 'agent',
        chat: targetChat,
        speakerId: turn.speakerId,
        roleplaySnapshot: { roleplay: turn.snapshot }
      });
      if (targetRagDocuments.length && !roleplayRequest && activeContextMode !== 'design') {
        const sources = targetRagDocuments.map((doc) => ({ name: doc.source, method: doc.extraction_method, warning: doc.extraction_warning }));
        systemPrompt += `\n\n${INGESTED_DOCUMENT_GUIDANCE}\n<attached_sources>\n${JSON.stringify(sources)}\n</attached_sources>`;
      }

      const outboundMessages = roleplayRequest?.messages ?? buildOutboundMessages({ messages: requestMessages, systemPrompt });
      // Context window budget check (local mode only). Roleplay fits its own budget above.
      if (!useToolLoop && activeBackendMode === 'local' && isElectron() && !roleplayRequest) {
        try {
          const electronApi = getElectronApi();
          if (electronApi) {
            await applyLocalContextBudgetTruncation({
              backendMode: activeBackendMode,
              isElectron: true,
              config: selectedConfig,
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

      // Home answers through the Rust runtime on every provider; a plain
      // Instant reply is just a turn without tools. Roleplay keeps its stream.
      if (useToolLoop || normalizeSpace(activeContextMode) === 'home') {
        // Design turns share Home's runtime; they swap in the design tools and prompt.
        const agentResult = await (activeContextMode === 'design' ? runDesignTask : runAgentTask)({
          chatId: targetChatId,
          designContext,
          ...this.homeRuntimeArgs(targetChat, assistantMessage, targetChat.messages.filter((entry) => entry.id !== assistantMessage.id).map((entry) => entry.id)),
          systemPrompt,
          messages: requestMessages,
          rawPrompt: content,
          conversationContext: searchConversationContext || (ragContext ? `<documents>\n${ragContext}\n</documents>` : undefined),
          executionMode: 'sandbox',
          toolMode: plan.toolMode,
          noTools: !useToolLoop,
          agentProfile: plan.agentProfile,
          searchMode: plan.searchMode,
          reasoningLevel: activeReasoningLevel,
          quietActivity: plan.instant,
          preserveDocumentContext: preserveDocuments,
          onMessagesInjected: (messages) => {
            const ids = this.voiceSteering.get(targetChatId);
            const accepted: ChatMessage[] = [];
            for (const text of messages) {
              const item = targetChat.pendingPrompts?.find(item => ids?.has(item.id) && item.content === text);
              if (!item) continue;
              ids!.delete(item.id);
              targetChat.pendingPrompts = targetChat.pendingPrompts!.filter(entry => entry.id !== item.id);
              accepted.push({ id: createId('msg'), role: 'user', content: text, createdAt: Date.now(), done: true, status: 'idle' });
            }
            if (!accepted.length) return;
            const index = targetChat.messages.findIndex(message => message.id === assistantMessage.id);
            if (index < 0) return;
            const prefix: ChatMessage[] = assistantMessage.content.trim()
              ? [{ ...assistantMessage, id: createId('msg'), done: true, status: 'idle', metadata: { ...assistantMessage.metadata, codeSpend: undefined }, agentSteps: undefined }]
              : [];
            assistantMessage.content = ''; assistantMessage.reasoning = '';
            targetChat.messages.splice(index, 0, ...prefix, ...accepted);
            syncMsg(true); this.persist();
          },
          ...plan.budget,
          signal: controller.signal,
          ...homeAgentCallbacks({
            message: assistantMessage,
            quiet: plan.instant,
            sync: syncMsg,
            persist: () => this.persist(),
            onReasoningStart: () => reasoningTimer.markStarted(),
            onArtifacts: (latest) => this.focusArtifact(targetChatId, assistantMessage.id, latest),
            touch: () => this.touchRun(targetChatId)
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
          requestedProvider: selectedConfig.search?.provider || 'aggregator'
        });
        if (selectedConfig.ui?.agent_debug_logs && (agentResult.warning || agentResult.error)) {
          console.info('[agent]', agentResult.warning || agentResult.error);
        }
        syncMsg(true);
        this.persist();
        this.focusArtifact(targetChatId, assistantMessage.id, agentResult.artifact);
      } else {
        await streamAssistantReply({
          config: this.configForChat(targetChat),
          messages: outboundMessages,
          signal: controller.signal,
          apiKey: activeProviderApiKey,
          reasoningLevel: activeReasoningLevel,
          sampling: roleplayRequest?.sampling ?? turn.sampling,
          stop: turn.stop,
          extraParams: roleplayRequest?.extraParams,
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

      if (!this.voiceModeActive && selectedConfig.tts?.enable_voice_output && selectedConfig.tts?.auto_play_voice && assistantMessage.content
        && (activeContextMode !== 'roleplay' || roleplayStore.settings(targetChat).voicePlayback !== false)) {
        try {
          if (activeContextMode === 'roleplay') ttsStore.speakSequence(messageSpeechParts(roleplayStore.resolveMessage(targetChat, assistantMessage), charactersStore.characters, this.config));
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
      const unsentVoice = this.voiceSteering.get(targetChatId);
      for (const item of this.findChat(targetChatId)?.pendingPrompts ?? []) if (unsentVoice?.has(item.id)) item.sending = false;
      this.voiceSteering.delete(targetChatId);
      // Group auto mode: queue the next character turn once this one settles.
      // A stopped or failed turn ends the chain instead of retrying.
      const continueQueued = this.queuedContinuation.delete(targetChatId) || (!controller.signal.aborted && assistantMessage.status !== 'error');
      if (continueQueued && this.findChat(targetChatId)?.pendingPrompts?.length) {
        void this.startNextQueuedPrompt(targetChatId);
      } else {
        roleplayStore.continueAuto(targetChatId, controller.signal.aborted || assistantMessage.status === 'error');
        roleplayStore.afterTurn(targetChatId, controller.signal.aborted || assistantMessage.status === 'error');
      }
    }
  }

  /** Show a run's artifact when its chat is on screen and the studio follows this message. */
  private focusArtifact(chatId: string, messageId: string, artifact: AgentArtifact | null | undefined) {
    if (this.currentChatId === chatId && (artifact || this.currentArtifactMessageId === messageId)) {
      this.setCurrentArtifact(artifact ?? null, messageId);
    }
  }

  stopStreaming(chatId = this.currentChatId || '') {
    this.queuedContinuation.delete(chatId);
    // The browser tool sets this when an agent starts driving a page, and only
    // the normal agent exit used to clear it — aborting left the "Agent" badge
    // stuck on the browser panel. Stopping a run is always a safe reset point.
    browserPanelStore.stopDriving(chatId);
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

  /**
   * One non-streamed completion on the active model (roleplay drafts and summaries).
   * Side calls skip thinking on a local model, where it is decoded at local speed.
   */
  async completeText(messages: RequestMessage[], options: { maxTokens?: number } = {}): Promise<string> {
    const result = await completeAssistantReply({
      apiKey: this.activeProvider?.api_key,
      messages,
      reasoningLevel: roleplayReasoningLevel({ thinkingEnabled: this.config.ui?.enable_thinking !== false, local: this.backendMode === 'local' }),
      maxTokens: options.maxTokens
    });
    return result.content || '';
  }

  /** The active model runs on this machine (the roleplay side calls key off it). */
  get localBackend(): boolean {
    return this.backendMode === 'local';
  }

  /** The thinking level a roleplay request asks for: the Settings toggle, the chat's choice, then the backend's default. */
  private roleplayThinking(chat: ChatSession, backend: GenerationBackendMode): ReasoningLevel | null {
    return roleplayReasoningLevel({
      chatLevel: chat.reasoningLevel ?? this.reasoningLevel,
      thinkingEnabled: this.config.ui?.enable_thinking !== false,
      local: backend === 'local'
    });
  }

  /**
   * The window a roleplay request must fit: the local runtime's per-request
   * context (llama-server's n_ctx, else the configured size), or the cloud
   * model's window from its catalog. Null when a cloud window is unknown.
   */
  private async roleplayContextWindow(backend: GenerationBackendMode): Promise<number | null> {
    if (backend === 'local') {
      try {
        const nCtx = Number((await getSupervisorStatus())?.n_ctx);
        if (Number.isFinite(nCtx) && nCtx > 0) return nCtx;
      } catch {
        // The runtime is not answering: the configured size stands in for it.
      }
      return Number(this.config.llm?.local?.context_length) || FALLBACK_CONTEXT_TOKENS;
    }
    const providerName = this.activeProviderName;
    const model = this.activeProvider?.model;
    if (!model) return null;
    const cached = this.apiModelMetadataByKey[buildApiModelMetadataCacheKey(providerName, model)];
    const metadata = cached ?? await this.fetchApiModelMetadata(providerName, model).catch(() => null);
    return metadata?.context_window || inferContextWindowFromModel(providerName, model);
  }

  /**
   * A roleplay request for one turn: the turn's stable block, history and
   * volatile tail, fitted to the window when the window is known. Local turns
   * carry the sampler preset and never exceed a quarter of the window. The
   * used record lands on the turn's snapshot, so the reply keeps it.
   */
  private async roleplayRequest(
    turn: RoleplayTurn,
    chat: ChatSession,
    history: RequestMessage[],
    backend: GenerationBackendMode
  ): Promise<{ messages: RequestMessage[]; sampling: RoleplaySampling; extraParams?: Record<string, number> }> {
    const contextTokens = await this.roleplayContextWindow(backend);
    const local = backend === 'local';
    const tuned = local
      ? localRoleplaySampling(turn.sampling, turn.snapshot?.settings ?? roleplayStore.settings(chat), contextTokens ?? undefined)
      : { sampling: turn.sampling, extra: {} };
    const extraParams = local && Object.keys(tuned.extra).length ? tuned.extra : undefined;
    if (!contextTokens) {
      const composed = turn.compose(history);
      turn.noteUsed(composed.used);
      return { messages: composed.messages, sampling: tuned.sampling, extraParams };
    }
    const reserve = completionReserve({ contextTokens, maxTokens: tuned.sampling.maxTokens, backend });
    const fitted = fitRoleplayRequest({
      contextTokens,
      reserve,
      history,
      compose: (messages, trim) => turn.compose(messages, trim)
    });
    turn.noteUsed(fitted.used);
    return { messages: fitted.messages, sampling: tuned.sampling, extraParams };
  }

  get contextRatio(): number {
    return (this.contextBudget?.usagePercent ?? 0) / 100;
  }

  /** Roleplay "Continue": the last reply keeps going, streamed onto the same message. */
  /** The reply "Continue" can extend: the last one in the current roleplay scene, with text. */
  private continuable(messageId: string) {
    const chat = this.currentChat;
    const message = chat?.messages.at(-1);
    const ok = chat?.contextMode === 'roleplay' && message?.id === messageId && message.role === 'assistant' && !!message.content.trim() && !isFailedReply(message);
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
    const wire = dropFailedReplies(roleplayStore.resolveHistory(chat, chat.messages, { user: turn.attribution?.userName }));
    const history = buildRequestMessagesFromHistory(wire, wire.length - 1, roleplayStore.attribution(chat, message.speakerId));
    const prefix = message.content;
    const version = message.versions?.[message.activeVersion ?? 0];
    const controller = new AbortController();
    let added = '';
    message.done = false;
    message.status = 'streaming';
    this.touchChats();
    try {
      this.beginGenerationRun(targetChatId, { controller, messageId: message.id, backendMode: activeBackendMode, mode: 'chat', startedAt: Date.now() });
      const request = await this.roleplayRequest(turn, chat, history, activeBackendMode);
      await streamAssistantReply({
        config: this.configForChat(chat),
        messages: [...request.messages, { role: 'system', content: CONTINUE_INSTRUCTION }],
        signal: controller.signal,
        apiKey: activeProvider?.api_key,
        reasoningLevel: this.roleplayThinking(chat, activeBackendMode),
        sampling: request.sampling,
        stop: turn.stop,
        extraParams: request.extraParams,
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

    // The regenerate keeps the persona its turn was built with, so {{user}} matches that prompt.
    const turnUser = (message.versions?.[message.activeVersion ?? 0]?.metadata?.roleplay ?? message.metadata?.roleplay)?.persona?.name;
    const resolvedBefore = roleplayStore.resolveHistory(chat, chat.messages, { user: turnUser }).slice(0, index);
    const wireBefore = chat.contextMode === 'roleplay' ? dropFailedReplies(resolvedBefore) : resolvedBefore;
    const previousMessages = buildRequestMessagesFromHistory(
      wireBefore,
      wireBefore.length - 1,
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
    // Home regenerates through the Rust runtime too (older plain-chat messages included).
    const agentic = message.mode === 'agent' || message.mode === 'instant' || getSpaceForSession(chat) === 'home';
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
      const reasoningLevel = this.roleplayThinking(chat, activeBackendMode);
      if (agentic) {
        const agentResult = await (getSpaceForSession(chat) === 'design' ? runDesignTask : runAgentTask)({
          chatId: targetChatId,
          ...this.homeRuntimeArgs(chat, message, chat.messages.slice(0, index).map((entry) => entry.id)),
          forkIndex: message.metadata?.homeSessionId === chat.homeRuntime?.sessionId && message.metadata?.homeRevision === chat.homeRuntime?.revision ? message.metadata?.homeConversationIndex : undefined,
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
            onArtifacts: (latest) => this.focusArtifact(targetChatId, message.id, latest),
            touch: () => this.touchRun(targetChatId)
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
        // Regenerate serves every chat: only a roleplay turn composes its own request.
        const request = chat.contextMode === 'roleplay'
          ? await this.roleplayRequest(turn, chat, previousMessages, activeBackendMode)
          : { messages: turn.decorate(buildOutboundMessages({ messages: previousMessages, systemPrompt })), sampling: turn.sampling, extraParams: undefined };
        await streamAssistantReply({
          config: this.configForChat(chat),
          messages: request.messages,
          signal: controller.signal,
          apiKey: activeProvider?.api_key,
          reasoningLevel,
          sampling: request.sampling,
          stop: turn.stop,
          extraParams: request.extraParams,
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

  private async commitConfig(next: AppConfig, options: ConfigCommitOptions = {}) {
    // Capture the owner before asynchronous persistence: switching chats while
    // saving must never pin the choice onto the newly visible conversation.
    const chat = this.currentChat;
    const selection = captureChatModel(next, this.backendMode);
    const selectionChanged = chat && JSON.stringify(chat.modelSelection) !== JSON.stringify(selection);
    if (selectionChanged) {
      chat.modelSelection = selection;
      this.markChatDirty(chat.id);
      this.persist();
    }
    this.config = next;
    if (selectionChanged) {
      ++this.contextBudgetRequestId;
      this.contextBudget = null;
    }
    await saveAppConfig(next);
    if (options.invalidateModels) invalidateModels();
    // Credentials are handed to main (which keeps them, or gives a provider's
    // to the Rust core), then discarded here. A browser session has no main.
    const sections = [isElectron() ? this.globalConfig.llm : undefined, this.globalConfig.tts, this.globalConfig.stt];
    for (const section of sections) {
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

  refreshModels(force?: boolean) { return this.modelDiscovery.refresh(force); }

  updateProvider(partial: ProviderUpdate, opts: { activate?: boolean } = {}) { return this.modelSettings.updateProvider(partial, opts); }
  addCustomProvider(input: { label: string; base_url: string }) { return this.modelSettings.addCustomProvider(input); }
  removeCustomProvider(id: string) { return this.modelSettings.removeCustomProvider(id); }
  setBackendMode(mode: 'local' | 'api') { return this.modelSettings.setBackendMode(mode); }
  setActiveProvider(id: string) { return this.modelSettings.setActiveProvider(id); }
  updateLocalModel(model: ModelOption) { return this.modelSettings.updateLocalModel(model); }
  updateLocalSettings(partial: LocalSettingsUpdate) { return this.modelSettings.updateLocalSettings(partial); }

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

  /**
   * How many chats the on-device server answers at once (`--parallel`). One
   * value for the whole app — the server is shared — so it lives in config,
   * not in a model's remembered load settings. Takes effect on the next load.
   */
  async setLocalParallel(slots: number) {
    const value = Math.max(1, Math.min(16, Math.floor(slots) || 1));
    this.localModelLoadParallel = String(value);
    await this.commitConfig({ ...this.config, llm: { ...this.config.llm, local: { ...(this.config.llm?.local ?? {}), parallel: value } } });
  }

  async setLocalRuntimePath(path: string) {
    await this.updateLocalSettings({ runtime_path: path });
    this.localModelLoadRuntimePath = path;
  }

  async updateUiSettings(partial: {
    show_assistant_text?: boolean;
    enable_thinking?: boolean;
    artifact_toggles?: Record<string, boolean>;
    home_tools_disabled?: string[];
    composer_mode_control?: 'tabs' | 'auto';
    roleplay_enabled?: boolean;
    editor?: string;
  }) {
    await this.commitConfig(mergeUiSettingsConfig(this.config, partial));
  }

  /** The editor "Open in editor" launches; empty means auto-detect. */
  get editorCommand(): string {
    return this.config.ui?.editor ?? '';
  }

  async setEditorCommand(command: string) {
    await this.updateUiSettings({ editor: command.trim() });
  }

  get composerModeControl(): 'tabs' | 'auto' {
    return this.config.ui?.composer_mode_control === 'tabs' ? 'tabs' : 'auto';
  }

  /**
   * Whether Roleplay is on. Home, Code and Design are the app's own spaces;
   * Roleplay is a niche one, so it ships off and Settings → General turns it on.
   */
  get roleplayEnabled(): boolean {
    return this.config.ui?.roleplay_enabled === true;
  }

  async setRoleplayEnabled(enabled: boolean) {
    await this.updateUiSettings({ roleplay_enabled: enabled });
    // Leaving the space while it is disabled must not strand the user in it —
    // and must not close the Settings screen the switch lives on.
    if (!enabled && this.activeSpace === 'roleplay') {
      const settingsOpen = this.settingsScreenOpen;
      this.setActiveSpace('home');
      this.settingsScreenOpen = settingsOpen;
    }
  }

  /** The optional Roleplay space is available only when enabled. */
  spaceEnabled(space: ChatContextMode): boolean {
    return space !== 'roleplay' || this.roleplayEnabled;
  }

  get homeToolsDisabled(): string[] {
    return this.config.ui?.home_tools_disabled ?? [];
  }

  async setHomeToolsDisabled(disabled: string[]) {
    await this.updateUiSettings({ home_tools_disabled: disabled });
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
