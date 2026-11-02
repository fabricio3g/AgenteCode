import { ipcMain, shell } from 'electron';
import { getMainWindow, requestMainWindowClose, setActiveWorkState } from './window-manager.ts';
import { panelOpenTab as createWebviewerWindow } from './browser-panel.ts';
import { loadConfig, saveConfig, updateConfig, loadConfigFromDisk } from './config.ts';
import { redactConfig } from './config.redact.ts';
import { getHardwareLimits, getSystemInfo } from './system-info.ts';
import {
  getLocalModels, getGgufMetadata, deleteLocalModel, getModelsDirPath,
  getIndexedModels, refreshModelIndex, invalidateModelCache, importLocalModel
} from './model-manager.ts';
import {
  startLlama, stopLlama, getInstalledRuntimes, deleteRuntimeBinary,
  getSupervisorStatus, getRuntimeTelemetry, supervisorHealthCheck, getLoadedModels,
  unloadModel, getRecommendedSettings, previewLocalModelCommand,
  startEmbeddingServer, stopEmbeddingServer
} from './llm-runner.ts';
import { getEmbeddingStatus } from './embedding-state.ts';
import { initTts, generateTtsStream, cancelTtsStream, unloadTts, checkEspeakData, listVoices, onWorkerMessage } from './voice/audiocpp-tts.ts';
import { registerVoiceModelHandlers } from './voice/voice-model-handlers.ts';
import { transcribeAudio, getSttStatus, preloadWhisper, unloadWhisper } from './stt-engine.ts';
import {
  startDownloadHf, getDownloadJobs, cancelDownloadJob,
  pauseDownloadJob, clearFinishedDownloads, removeDownloadJob,
  restorePersistedJobs, setAutoLoadHandler
} from './model-download.ts';
import {
  ingestDocument, readIngestedDocument, ingestText, ingestTextFast, queryDocuments,
  listRagDocuments, removeRagDocument, clearRagDocuments, hasRagDocuments
} from './rag-engine.ts';
import {
  webSearch, ingestSearchContext, fetchModelCatalog,
  searchHfModels, hfRepoGguf, fetchHfReadme
} from './search-engine.ts';
import { scrapeUrlStructured } from './web-scraper.ts';
import { crawlWeb } from './web-crawler.ts';
import { getAggregatorCatalog, probeAggregatorEngines } from './search-providers/aggregator.ts';
import {
  pathExists, openModelsFolder, pickWorkspaceFolder, pickModelFile, pickMmprojFile, pickWhisperRuntimeFile,
  indexWorkspaceFolder, snapshotWorkspaceFiles, writeWorkspaceFile, readWorkspaceFile,
  createWorkspaceDocument, renameWorkspaceFile, deleteWorkspaceFile,
  openWorkspaceFile, createWorkspaceFolder, workspaceExec, writeTempFile,
  resetMediaPermissions
} from './filesystem.ts';
import { downloadRuntime } from './runtime-download.ts';

import {
  panelOpenTab, panelListTabs, panelSetActive, panelCloseTab, panelCloseAll,
  panelSetVisible, panelSetOccluded, panelSetBounds, panelSetPresentation, panelSetViewport,
  panelNavigate as browserNavigate, panelSnapshot as browserSnapshot,
  panelClick as browserClick, panelTypeText as browserTypeText,
  panelEvaluate as browserEvaluate, panelScreenshot as browserScreenshot,
  panelCurrentUrl as browserGetCurrentUrl, panelCloseTab as browserClose
} from './browser-panel.ts';
import {
  generatePptx, parseSlidesFromMarkdown, slidesToMarkdown
} from './slides.ts';
import {
  generateDocx, generateXlsx, generatePdf
} from './generated-documents.ts';
import { completeChatRequest, startChatStream, cancelChatStream } from './chat-ipc.ts';
import { resolveApiKey } from './provider-auth.ts';
import { resolveProvider } from './providers/registry.ts';
import { chatDatabase } from './chat-db-client.ts';
import { countTokens, buildContextBudget, truncateMessages } from './token-counter.ts';
import { registerWindowHandlers } from './ipc/window-handlers.ts';
import { registerConfigHandlers } from './ipc/config-handlers.ts';
import { registerAppCapabilityHandlers } from './ipc/app-capability-handlers.ts';
import { registerRuntimeHandlers } from './ipc/runtime-handlers.ts';
import { registerTtsHandlers } from './ipc/tts-handlers.ts';
import { registerSttHandlers } from './ipc/stt-handlers.ts';
import { registerEngineHandlers } from './ipc/engine-handlers.ts';
import { registerInstanceHandlers } from './ipc/instance-handlers.ts';
import { registerWhisperHandlers } from './ipc/whisper-handlers.ts';
import { registerProviderHandlers } from './ipc/provider-handlers.ts';
import { invalidateProviderDiscovery } from './agente/thinking.ts';
import { registerChatHandlers } from './ipc/chat-handlers.ts';
import { registerChatDbHandlers } from './ipc/chat-db-handlers.ts';
import { registerFilesHandlers } from './ipc/files-handlers.ts';
import { registerTokenHandlers } from './ipc/token-handlers.ts';
import { registerDownloadHandlers } from './ipc/download-handlers.ts';
import { registerRagHandlers } from './ipc/rag-handlers.ts';
import { registerSearchHandlers } from './ipc/search-handlers.ts';
import { registerLiveDataHandlers } from './ipc/live-data-handlers.ts';
import { registerModelManagementHandlers } from './ipc/model-handlers.ts';
import { registerLlmRunnerHandlers } from './ipc/llm-runner-handlers.ts';
import { registerWorkspaceHandlers } from './ipc/workspace-handlers.ts';
import { registerToolingHandlers } from './ipc/tooling-handlers.ts';
import { registerBrowserAgentHandlers } from './ipc/browser-agent-handlers.ts';
import { registerCodeWorkspaceHandlers, disposeCodeWorkspace } from './ipc/code-workspace-handlers.ts';
import { registerAgenteHandlers, disposeAgenteSessions as disposeAllAgenteSessions } from './ipc/agente-handlers.ts';
import { registerBrowserChat, stopBrowserChat } from './agente/browser-chat.ts';
import { registerDesignHandlers } from './ipc/design-handlers.ts';
import { registerDesignReferenceHandlers } from './ipc/design-reference-handlers.ts';
import { registerComputerHandlers } from './computer/desktop.ts';
import type { ErrorMessageFn } from './ipc/types.ts';
import { createLogger } from './utils/logger.ts';

const log = createLogger('[IPC]');

const toErrorMessage: ErrorMessageFn = (err: unknown): string => {
  return err instanceof Error ? err.message : String(err);
};

export function registerIpcHandlers() {
  // ── Window controls ──
  registerWindowHandlers({
    ipcMain,
    getMainWindow,
    requestMainWindowClose,
    setActiveWorkState,
  });

  // ── Hardware / first-run / capabilities ──
  registerAppCapabilityHandlers({
    ipcMain,
    getHardwareLimits,
    loadConfig,
    getSystemInfo,
  });

  // ── Config ──
  registerConfigHandlers({
    ipcMain,
    loadConfig,
    redactConfig,
    loadConfigFromDisk,
    saveConfig,
    updateConfig,
  });

  // ── Model management ──
  registerModelManagementHandlers({
    ipcMain,
    getLocalModels,
    getGgufMetadata,
    deleteLocalModel,
    getModelsDirPath,
    getIndexedModels,
    refreshModelIndex,
    invalidateModelCache,
    importLocalModel,
  });

  // ── LLM runner + embedding server ──
  registerLlmRunnerHandlers({
    ipcMain,
    getMainWindow,
    startLlama,
    stopLlama,
    getSupervisorStatus,
    getRuntimeTelemetry,
    supervisorHealthCheck,
    getLoadedModels,
    unloadModel,
    getRecommendedSettings,
    previewLocalModelCommand,
    startEmbeddingServer,
    stopEmbeddingServer,
    getEmbeddingStatus,
  });

  // ── Runtimes ──
  registerRuntimeHandlers({
    ipcMain,
    getMainWindow,
    getInstalledRuntimes,
    deleteRuntimeBinary,
    downloadRuntime,
  });

  // ── TTS ──
  registerTtsHandlers({
    ipcMain,
    getMainWindow,
    initTts,
    generateTtsStream,
    cancelTtsStream,
    unloadTts,
    checkEspeakData,
    listVoices,
    onWorkerMessage,
    logger: (message, ...args) => log.info(message, ...args),
  });
  registerVoiceModelHandlers(ipcMain);

  // ── STT (speech-to-text) ──
  registerEngineHandlers(ipcMain);
  registerInstanceHandlers(ipcMain);
  registerSttHandlers({
    ipcMain,
    transcribeAudio,
    preloadWhisper,
    getSttStatus,
    unloadWhisper,
  });

  // ── Whisper runtime management ──
  registerWhisperHandlers({
    ipcMain,
    getMainWindow,
  });



  // ── Provider / model API handlers ──
  registerProviderHandlers({
    ipcMain,
    resolveProvider,
    resolveApiKey,
    onModelsRefreshed: invalidateProviderDiscovery,
  });

  // ── Chat (main-process network for API key safety) ──
  registerChatHandlers({
    ipcMain,
    getMainWindow,
    completeChatRequest,
    startChatStream,
    cancelChatStream,
  });

  // ── Chat DB (SQLite persistence) ──
  registerChatDbHandlers({
    ipcMain,
    saveChatDraft: (...args) => chatDatabase.request('saveChatDraft', ...args),
    saveChatSession: (...args) => chatDatabase.request('saveChatSession', ...args),
    loadAllChats: (...args) => chatDatabase.request('loadAllChats', ...args),
    searchChatContent: (...args) => chatDatabase.request('searchChatContent', ...args),
    deleteChatFromDb: (...args) => chatDatabase.request('deleteChatFromDb', ...args),
    clearRagDocuments,
    migrateFromLocalStorage: (...args) => chatDatabase.request('migrateFromLocalStorage', ...args),
    loadAllFolders: (...args) => chatDatabase.request('loadAllFolders', ...args),
    saveFolder: (...args) => chatDatabase.request('saveFolder', ...args),
    deleteFolder: (...args) => chatDatabase.request('deleteFolder', ...args),
    loadAllCodeProjects: (...args) => chatDatabase.request('loadAllCodeProjects', ...args),
    saveCodeProject: (...args) => chatDatabase.request('saveCodeProject', ...args),
    deleteCodeProject: (...args) => chatDatabase.request('deleteCodeProject', ...args),
    loadAllCharacters: (...args) => chatDatabase.request('loadAllCharacters', ...args),
    saveCharacter: (...args) => chatDatabase.request('saveCharacter', ...args),
    deleteCharacter: (...args) => chatDatabase.request('deleteCharacter', ...args),
    loadAllPersonas: (...args) => chatDatabase.request('loadAllPersonas', ...args),
    savePersona: (...args) => chatDatabase.request('savePersona', ...args),
    deletePersona: (...args) => chatDatabase.request('deletePersona', ...args),
    loadAllWorlds: (...args) => chatDatabase.request('loadAllWorlds', ...args),
    saveWorld: (...args) => chatDatabase.request('saveWorld', ...args),
    deleteWorld: (...args) => chatDatabase.request('deleteWorld', ...args),
  });

  // ── File registry (global content-addressed store, shared with the TUI) ──
  registerFilesHandlers({
    ipcMain,
    listFiles: () => chatDatabase.request('listFileRecords'),
    getFile: (hash) => chatDatabase.request('getFileRecord', hash),
    listFileRefs: (hash) => chatDatabase.request('listFileRefs', hash),
    setFilePinned: (hash, pinned) => chatDatabase.request('setFilePinned', hash, pinned),
    deleteFile: (hash) => chatDatabase.request('deleteFileRecord', hash),
    fileStats: () => chatDatabase.request('fileStoreStats'),
    trashItem: (target) => shell.trashItem(target),
  });

  // ── Token counting / context budget ──
  registerTokenHandlers({
    ipcMain,
    countTokens,
    buildContextBudget,
    truncateMessages,
  });

  // ── Downloads ──
  // Restore jobs persisted by a previous session: anything that was mid-flight
  // comes back as `interrupted` and resumes from its .part on demand.
  restorePersistedJobs();

  // "Download & load when ready": completed jobs hand the model to the same
  // runtime path a manual load takes — recommended settings, no user overrides.
  setAutoLoadHandler((modelPath) => {
    void (async () => {
      const settings = await getRecommendedSettings(modelPath, null, null, '') as Record<string, unknown>;
      await startLlama({
        model_path: modelPath,
        backend_mode: settings.backend || 'auto',
        host: '127.0.0.1',
        port: 11435,
        context_length: settings.context_length,
        gpu_offload: settings.gpu_layers,
        cpu_threads: settings.cpu_threads,
        batch_size: settings.batch_size,
        flash_attention: settings.flash_attention,
        offload_kv_cache: settings.offload_kv
      }, getMainWindow());
    })().catch((err) => {
      console.warn('[downloads] auto-load failed:', err);
    });
  });

  registerDownloadHandlers({
    ipcMain,
    startDownloadHf,
    getDownloadJobs,
    cancelDownloadJob,
    pauseDownloadJob,
    clearFinishedDownloads,
    removeDownloadJob,
  });

  // ── RAG ──
  registerRagHandlers({
    ipcMain,
    ingestDocument,
    readIngestedDocument,
    ingestText,
    ingestTextFast,
    queryDocuments,
    listRagDocuments,
    removeRagDocument,
    clearRagDocuments,
    hasRagDocuments,
  });

  // ── Search ──
  registerSearchHandlers({
    ipcMain,
    shell,
    getMainWindow,
    webSearch,
    ingestSearchContext,
    fetchModelCatalog,
    searchHfModels,
    hfRepoGguf,
    fetchHfReadme,
    createWebviewerWindow,
    scrapeUrlStructured,
    crawlWeb,
    getAggregatorCatalog,
    probeAggregatorEngines,
    toErrorMessage,
  });

  // ── Live data (weather / FX / quotes — open free APIs) ──
  registerLiveDataHandlers({ ipcMain, toErrorMessage });

  // ── Workspace / filesystem ──
  registerWorkspaceHandlers({
    ipcMain,
    pathExists,
    openModelsFolder,
    pickWorkspaceFolder,
    pickModelFile,
    pickMmprojFile,
    pickWhisperRuntimeFile,
    indexWorkspaceFolder,
    snapshotWorkspaceFiles,
    writeWorkspaceFile,
    readWorkspaceFile,
    createWorkspaceDocument,
    renameWorkspaceFile,
    deleteWorkspaceFile,
    openWorkspaceFile,
    createWorkspaceFolder,
    workspaceExec,
    writeTempFile,
    resetMediaPermissions,
  });

  // ── Sandbox / browser / slides ──
  registerBrowserAgentHandlers(ipcMain);
  registerComputerHandlers(ipcMain);
  registerCodeWorkspaceHandlers(ipcMain);
  registerToolingHandlers({
    ipcMain,
    panelOpenTab,
    panelListTabs,
    panelSetActive,
    panelCloseTab,
    panelCloseAll,
    panelSetVisible,
    panelSetOccluded,
    panelSetBounds,
    panelSetPresentation,
    panelSetViewport,
    browserNavigate,
    browserSnapshot,
    browserClick,
    browserTypeText,
    browserEvaluate,
    browserScreenshot,
    browserGetCurrentUrl,
    browserClose,
    generatePptx,
    parseSlidesFromMarkdown,
    slidesToMarkdown,
    generateDocx,
    generateXlsx,
    generatePdf,
  });

  // ── Agente Coding (built-in coding agent engine) ──
  registerAgenteHandlers({
    ipcMain,
    getMainWindow,
  });

  // ── Browser chat (the extension's side panel, answered with Home turns) ──
  registerBrowserChat(ipcMain, getMainWindow);

  // ── Design (per-chat HTML/CSS workspaces, path-jailed) ──
  registerDesignHandlers(ipcMain);
  registerDesignReferenceHandlers(ipcMain);
}

export { disposeAllAgenteSessions, disposeCodeWorkspace, stopBrowserChat };
