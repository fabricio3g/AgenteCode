import { ipcMain, shell } from 'electron';
import { getMainWindow, createWebviewerWindow, requestMainWindowClose, setActiveWorkState } from './window-manager.ts';
import { loadConfig, saveConfig, updateConfig, redactConfig, loadConfigFromDisk } from './config.ts';
import { getHardwareLimits, getSystemInfo } from './system-info.ts';
import {
  getLocalModels, getGgufMetadata, deleteLocalModel, getModelsDirPath,
  getIndexedModels, refreshModelIndex, invalidateModelCache, importLocalModel
} from './model-manager.ts';
import {
  startLlama, stopLlama, getInstalledRuntimes, deleteRuntimeBinary,
  getSupervisorStatus, supervisorHealthCheck, getLoadedModels,
  unloadModel, getRecommendedSettings,
  startEmbeddingServer, stopEmbeddingServer, getEmbeddingStatus
} from './llm-runner.ts';
import { initTts, generateTtsStream, cancelTtsStream, unloadTts, checkEspeakData, listVoices, onWorkerMessage } from './tts-engine.ts';
import { transcribeAudio, getSttStatus, unloadWhisper } from './stt-engine.ts';
import {
  startDownloadHf, getDownloadJobs, cancelDownloadJob,
  pauseDownloadJob, clearFinishedDownloads, removeDownloadJob
} from './download-manager.ts';
import {
  ingestDocument, ingestText, ingestTextFast, queryDocuments,
  listRagDocuments, removeRagDocument, clearRagDocuments, hasRagDocuments
} from './rag-engine.ts';
import {
  webSearch, ingestSearchContext, fetchModelCatalog,
  searchHfModels, hfRepoGguf
} from './search-engine.ts';
import { scrapeUrlStructured } from './web-scraper.ts';
import { crawlWeb } from './web-crawler.ts';
import {
  pathExists, openModelsFolder, pickWorkspaceFolder, pickModelFile, pickMmprojFile, pickWhisperRuntimeFile,
  indexWorkspaceFolder, writeWorkspaceFile, readWorkspaceFile,
  createWorkspaceDocument, renameWorkspaceFile, deleteWorkspaceFile,
  openWorkspaceFile, createWorkspaceFolder, workspaceExec, writeTempFile,
  resetMediaPermissions
} from './filesystem.ts';
import { downloadRuntime } from './runtime-download.ts';

import { sandboxExec } from './sandbox.ts';
import {
  browserNavigate, browserSnapshot, browserClick, browserTypeText,
  browserEvaluate, browserScreenshot, browserGetCurrentUrl, browserClose
} from './browser-control.ts';
import {
  generatePptx, savePptx, parseSlidesFromMarkdown, slidesToMarkdown
} from './slides.ts';
import {
  generateDocx, generateXlsx, generatePdf
} from './generated-documents.ts';
import { completeChatRequest, startChatStream, cancelChatStream, resolveApiKey } from './chat-ipc.ts';
import { resolveProvider } from './providers/registry.ts';
import { saveChatSession, loadAllChats, deleteChat as deleteChatFromDb, migrateFromLocalStorage, loadAllFolders, saveFolder, deleteFolder } from './chat-db.ts';
import { countTokens, buildContextBudget, truncateMessages } from './token-counter.ts';
import { registerWindowHandlers } from './ipc/window-handlers.ts';
import { registerConfigHandlers } from './ipc/config-handlers.ts';
import { registerAppCapabilityHandlers } from './ipc/app-capability-handlers.ts';
import { registerRuntimeHandlers } from './ipc/runtime-handlers.ts';
import { registerTtsHandlers } from './ipc/tts-handlers.ts';
import { registerSttHandlers } from './ipc/stt-handlers.ts';
import { registerWhisperHandlers } from './ipc/whisper-handlers.ts';
import { registerProviderHandlers } from './ipc/provider-handlers.ts';
import { registerChatHandlers } from './ipc/chat-handlers.ts';
import { registerChatDbHandlers } from './ipc/chat-db-handlers.ts';
import { registerTokenHandlers } from './ipc/token-handlers.ts';
import { registerDownloadHandlers } from './ipc/download-handlers.ts';
import { registerRagHandlers } from './ipc/rag-handlers.ts';
import { registerSearchHandlers } from './ipc/search-handlers.ts';
import { registerModelManagementHandlers } from './ipc/model-handlers.ts';
import { registerLlmRunnerHandlers } from './ipc/llm-runner-handlers.ts';
import { registerWorkspaceHandlers } from './ipc/workspace-handlers.ts';
import { registerToolingHandlers } from './ipc/tooling-handlers.ts';
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
    supervisorHealthCheck,
    getLoadedModels,
    unloadModel,
    getRecommendedSettings,
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
    deleteChatFromDb,
    clearRagDocuments,
    migrateFromLocalStorage,
    loadAllFolders,
    saveFolder,
    deleteFolder,
  });

  // ── Token counting / context budget ──
  registerTokenHandlers({
    ipcMain,
    countTokens,
    buildContextBudget,
    truncateMessages,
  });

  // ── Downloads ──
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
    createWebviewerWindow,
    scrapeUrlStructured,
    crawlWeb,
    toErrorMessage,
  });

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
  registerToolingHandlers({
    ipcMain,
    sandboxExec,
    browserNavigate,
    browserSnapshot,
    browserClick,
    browserTypeText,
    browserEvaluate,
    browserScreenshot,
    browserGetCurrentUrl,
    browserClose,
    generatePptx,
    savePptx,
    parseSlidesFromMarkdown,
    slidesToMarkdown,
    generateDocx,
    generateXlsx,
    generatePdf,
  });
}
