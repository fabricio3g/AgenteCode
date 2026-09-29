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
import { initTts, generateTtsStream, cancelTtsStream, unloadTts, checkEspeakData, listVoices, onWorkerMessage } from './tts-engine.ts';
import { transcribeAudio, getSttStatus, unloadWhisper } from './stt-engine.ts';
import {
  startDownloadHf, getDownloadJobs, cancelDownloadJob,
  pauseDownloadJob, clearFinishedDownloads, removeDownloadJob,
  restorePersistedJobs, setAutoLoadHandler
} from './model-download.ts';
import {
  ingestDocument, ingestText, ingestTextFast, queryDocuments,
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

import { sandboxExec } from './sandbox.ts';
import {
  panelOpenTab, panelListTabs, panelSetActive, panelCloseTab, panelCloseAll,
  panelSetVisible, panelSetBounds, panelSetViewport,
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
import { completeChatRequest, startChatStream, cancelChatStream, resolveApiKey } from './chat-ipc.ts';
import { resolveProvider } from './providers/registry.ts';
import { saveChatSession, loadAllChats, searchChatContent, deleteChat as deleteChatFromDb, migrateFromLocalStorage, loadAllFolders, saveFolder, deleteFolder, loadAllCodeProjects, saveCodeProject, deleteCodeProject, loadAllCharacters, saveCharacter, deleteCharacter, loadAllPersonas, savePersona, deletePersona, loadAllWorlds, saveWorld, deleteWorld } from './chat-db.ts';
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
import { registerChatHandlers } from './ipc/chat-handlers.ts';
import { registerChatDbHandlers } from './ipc/chat-db-handlers.ts';
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
import { registerBotHandlers } from './agente/bots.ts';
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

  // ── STT (speech-to-text) ──
  registerEngineHandlers(ipcMain);
  registerInstanceHandlers(ipcMain);
  registerSttHandlers({
    ipcMain,
    transcribeAudio,
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
    saveChatSession,
    loadAllChats,
    searchChatContent,
    deleteChatFromDb,
    clearRagDocuments,
    migrateFromLocalStorage,
    loadAllFolders,
    saveFolder,
    deleteFolder,
    loadAllCodeProjects,
    saveCodeProject,
    deleteCodeProject,
    loadAllCharacters,
    saveCharacter,
    deleteCharacter,
    loadAllPersonas,
    savePersona,
    deletePersona,
    loadAllWorlds,
    saveWorld,
    deleteWorld,
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
  registerCodeWorkspaceHandlers(ipcMain);
  registerToolingHandlers({
    ipcMain,
    sandboxExec,
    panelOpenTab,
    panelListTabs,
    panelSetActive,
    panelCloseTab,
    panelCloseAll,
    panelSetVisible,
    panelSetBounds,
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

  // ── Agente Bot (the bots living in the same runtime) ──
  registerBotHandlers(ipcMain, getMainWindow);
}

export { disposeAllAgenteSessions, disposeCodeWorkspace };
