import { ipcMain, shell } from 'electron';
import { getMainWindow, createWebviewerWindow, requestMainWindowClose, setActiveWorkState } from './index.js';
import { loadConfig, saveConfig, updateConfig, redactConfig, loadConfigFromDisk } from './config.js';
import { getHardwareLimits, getSystemInfo } from './system-info.js';
import {
  getLocalModels, getGgufMetadata, deleteLocalModel, getModelsDirPath,
  getIndexedModels, refreshModelIndex, invalidateModelCache, importLocalModel
} from './model-manager.js';
import {
  startLlama, stopLlama, getInstalledRuntimes, deleteRuntimeBinary,
  getSupervisorStatus, supervisorHealthCheck, getLoadedModels,
  unloadModel, getRecommendedSettings,
  startEmbeddingServer, stopEmbeddingServer, getEmbeddingStatus
} from './llm-runner.js';
import { generateTts, unloadTts, checkEspeakData } from './tts-engine.js';
import { transcribeAudio, getSttStatus, unloadWhisper } from './stt-engine.js';
import {
  startDownloadHf, getDownloadJobs, cancelDownloadJob,
  pauseDownloadJob, clearFinishedDownloads, removeDownloadJob
} from './download-manager.js';
import {
  ingestDocument, ingestText, ingestTextFast, queryDocuments,
  listRagDocuments, removeRagDocument, clearRagDocuments, hasRagDocuments
} from './rag-engine.js';
import {
  webSearch, ingestSearchContext, fetchModelCatalog,
  searchHfModels, hfRepoGguf
} from './search-engine.js';
import { scrapeUrlStructured } from './web-scraper.js';
import { crawlWeb } from './web-crawler.js';
import {
  pathExists, openModelsFolder, pickWorkspaceFolder, pickModelFile,
  indexWorkspaceFolder, writeWorkspaceFile, readWorkspaceFile,
  createWorkspaceDocument, renameWorkspaceFile, deleteWorkspaceFile,
  openWorkspaceFile, createWorkspaceFolder, workspaceExec, writeTempFile,
  resetMediaPermissions, downloadRuntime
} from './workspace.js';
import {
  agentStartTask, agentUpdateTask, agentCancelTask,
  agentGetTask, agentListTasks, agentDeleteTask, agentClearHistory,
  agentRunner
} from './agent-manager.js';
import { sandboxExec } from './sandbox.js';
import {
  browserNavigate, browserSnapshot, browserClick, browserTypeText,
  browserEvaluate, browserScreenshot, browserGetCurrentUrl, browserClose
} from './browser-control.js';
import {
  generatePptx, savePptx, parseSlidesFromMarkdown, slidesToMarkdown
} from './slides.js';
import { completeChatRequest, startChatStream, cancelChatStream, resolveApiKey } from './chat-ipc.js';
import { resolveProvider } from './providers/registry.js';
import { saveChatSession, loadAllChats, deleteChat as deleteChatFromDb, migrateFromLocalStorage, loadAllFolders, saveFolder, deleteFolder } from './chat-db.js';
import { countTokens, buildContextBudget, truncateMessages } from './token-counter.js';

export function registerIpcHandlers() {
  // ── Window controls ──
  ipcMain.handle('window:minimize', () => {
    const win = getMainWindow();
    win?.minimize();
  });

  ipcMain.handle('window:toggle-maximize', async () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle('window:is-maximized', () => {
    return getMainWindow()?.isMaximized() ?? false;
  });

  ipcMain.handle('window:close', () => {
    return requestMainWindowClose();
  });

  ipcMain.handle('window:request-close', () => {
    return requestMainWindowClose();
  });

  ipcMain.handle('window:set-active-work', (_e, payload) => {
    return setActiveWorkState(payload || {});
  });

  // ── Hardware ──
  ipcMain.handle('get_hardware_limits', () => getHardwareLimits());

  // ── First-run check ──
  ipcMain.handle('is_first_run', () => {
    const cfg = loadConfig();
    return !cfg?.onboarding?.completed;
  });

  ipcMain.handle('get_runtime_recommendations', async () => {
    const info = await getSystemInfo();
    const platform = info.os_platform;
    const arch = info.os_arch;
    let osLabel = 'linux';
    if (platform === 'darwin') osLabel = 'macos';
    else if (platform === 'win32') osLabel = 'windows';
    return {
      platform: osLabel,
      arch: arch === 'arm64' ? 'arm64' : 'x64',
      gpu_backend: info.gpu_backend,
      has_gpu: info.vram_gb > 0,
      recommended_variant: info.gpu_backend === 'cuda' ? 'cuda'
        : info.gpu_backend === 'metal' ? 'metal'
        : info.gpu_backend === 'vulkan' ? 'vulkan'
        : 'cpu'
    };
  });

  // ── Desktop capabilities ──
  ipcMain.handle('get_desktop_capabilities', () => ({
    platform: process.platform,
    desktop_shell: true,
    local_runtime: true,
    local_tts: true,
    audio_recording: true,
    rag_indexing: true,
    web_search: true,
    sandbox_exec: true,
    agent_runtime: true
  }));

  // ── Config ──
  ipcMain.handle('get_config', () => redactConfig(loadConfig()));
  ipcMain.handle('save_config', (_e, cfg) => {
    // Preserve real API keys: the renderer never sees actual keys (they're
    // redacted by get_config), so we must restore them from the on-disk config
    // before writing.  We read from disk directly to avoid depending on the
    // in-memory _config cache which can be stale or incomplete.
    const diskConfig = loadConfigFromDisk();
    const incomingProviders = cfg?.llm?.providers || {};
    const diskProviders = diskConfig?.llm?.providers || {};
    for (const [name, provider] of Object.entries(incomingProviders)) {
      if (!provider.api_key && diskProviders[name]?.api_key) {
        provider.api_key = diskProviders[name].api_key;
      }
      // Clean up the renderer-side flag; real config stores the actual key
      delete provider.has_api_key;
    }
    // Also preserve search provider API keys
    const incomingSearchProviders = cfg?.search?.providers || {};
    const diskSearchProviders = diskConfig?.search?.providers || {};
    for (const [name, provider] of Object.entries(incomingSearchProviders)) {
      if (provider && typeof provider === 'object' && !provider.api_key && diskSearchProviders[name]?.api_key) {
        provider.api_key = diskSearchProviders[name].api_key;
      }
    }
    return saveConfig(cfg);
  });
  ipcMain.handle('update_config', (_e, partial) => updateConfig(partial));

  // ── Model management ──
  ipcMain.handle('get_local_models', () => getLocalModels());
  ipcMain.handle('get_gguf_metadata', (_e, { filePath }) => getGgufMetadata(filePath));
  ipcMain.handle('delete_local_model', (_e, { path }) => deleteLocalModel(path));
  ipcMain.handle('get_models_dir_path', () => getModelsDirPath());
  ipcMain.handle('get_indexed_models', () => getIndexedModels());
  ipcMain.handle('refresh_model_index', () => refreshModelIndex());
  ipcMain.handle('invalidate_model_cache', (_e, { path }) => invalidateModelCache(path));
  ipcMain.handle('import_local_model', (_e, args) => importLocalModel(args));

  // ── LLM runner ──
  ipcMain.handle('start_llama', (_e, { config }) => startLlama(config, getMainWindow()));
  ipcMain.handle('stop_llama', () => stopLlama(getMainWindow()));
  ipcMain.handle('get_supervisor_status', () => getSupervisorStatus());
  ipcMain.handle('supervisor_health_check', () => supervisorHealthCheck());
  ipcMain.handle('get_loaded_models', () => getLoadedModels());
  ipcMain.handle('unload_model', (_e, { modelId }) => unloadModel(modelId, getMainWindow()));
  ipcMain.handle('get_recommended_settings', (_e, { modelPath, userContext, userGpuLayers, runtimePath }) =>
    getRecommendedSettings(modelPath, userContext, userGpuLayers, runtimePath));

  // ── Embedding server ──
  ipcMain.handle('start_embedding_server', (_e, { config }) => startEmbeddingServer(config, getMainWindow()));
  ipcMain.handle('stop_embedding_server', () => stopEmbeddingServer());
  ipcMain.handle('get_embedding_status', () => getEmbeddingStatus());

  // ── Runtimes ──
  ipcMain.handle('get_installed_runtimes', () => getInstalledRuntimes());
  ipcMain.handle('delete_runtime_binary', (_e, { path }) => deleteRuntimeBinary(path));
  ipcMain.handle('download_runtime', (_e, { payload }) => downloadRuntime(payload, getMainWindow()));

  // ── TTS ──
  ipcMain.handle('generate_tts', (_e, { request }) => generateTts(request));
  ipcMain.handle('unload_tts', () => unloadTts());
  ipcMain.handle('check_espeak_data', (_e, { modelsDir }) => checkEspeakData(modelsDir));

  // ── STT (speech-to-text) ──
  ipcMain.handle('stt_transcribe', (_e, args) => {
    // IPC transfers TypedArrays as plain objects; force a fresh copy to avoid "External buffers" errors
    const reconstructedArgs = { ...args };
    if (args?.audio_bytes && typeof args.audio_bytes === 'object' && !Buffer.isBuffer(args.audio_bytes)) {
      // Get length and allocate fresh Buffer, then copy byte-by-byte
      const src = args.audio_bytes;
      const len = src.length !== undefined ? src.length : Object.keys(src).filter(k => /^\d+$/.test(k)).length;
      const copy = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        copy[i] = src[i] ?? 0;
      }
      reconstructedArgs.audio_bytes = copy;
    }
    return transcribeAudio(reconstructedArgs);
  });
  ipcMain.handle('get_stt_status', () => getSttStatus());
  ipcMain.handle('unload_whisper', () => unloadWhisper());

  // ── Provider model list (delegated to provider registry) ──
  ipcMain.handle('fetch_provider_models', async (_e, { baseUrl, apiKey, providerName }) => {
    const provider = resolveProvider(providerName, baseUrl);
    const realKey = resolveApiKey(apiKey, baseUrl, providerName);
    if (!realKey && provider.name !== 'local') {
      throw new Error(`No API key configured for ${providerName || 'the selected provider'}. Please add your API key in Settings > LLM Providers.`);
    }
    return provider.fetchModels(realKey, baseUrl);
  });

  ipcMain.handle('get_api_model_context', async (_e, { baseUrl, apiKey, providerName, modelId }) => {
    const provider = resolveProvider(providerName, baseUrl);
    const realKey = resolveApiKey(apiKey, baseUrl, providerName);
    if (!realKey && provider.name !== 'local') {
      return null;
    }
    const result = await provider.fetchModelMetadata(realKey, baseUrl, modelId);
    return result;
  });

  // ── Chat (main-process network for API key safety) ──
  ipcMain.handle('chat_complete', (_e, args) => completeChatRequest(args));
  ipcMain.handle('chat_stream_start', (_e, args) => startChatStream(args, getMainWindow()));
  ipcMain.handle('chat_stream_cancel', (_e, args) => cancelChatStream(args));

  // ── Chat DB (SQLite persistence) ──
  ipcMain.handle('chat_db_save_session', (_e, { session }) => saveChatSession(session));
  ipcMain.handle('chat_db_load_all', () => loadAllChats());
  ipcMain.handle('chat_db_delete', async (_e, { chatId }) => {
    await deleteChatFromDb(chatId);
    clearRagDocuments(chatId).catch(() => {});
  });
  ipcMain.handle('chat_db_migrate', (_e, { persistedState }) => migrateFromLocalStorage(persistedState));
  ipcMain.handle('chat_db_load_folders', () => loadAllFolders());
  ipcMain.handle('chat_db_save_folder', (_e, { folder }) => saveFolder(folder));
  ipcMain.handle('chat_db_delete_folder', (_e, { folderId }) => deleteFolder(folderId));

  // ── Token counting / context budget ──
  ipcMain.handle('count_tokens', (_e, { text, baseUrl }) => countTokens(text, baseUrl));
  ipcMain.handle('build_context_budget', (_e, { config, messages }) => buildContextBudget(config, messages));
  ipcMain.handle('truncate_messages', (_e, { messages, budget }) => truncateMessages(messages, budget));

  // ── Downloads ──
  ipcMain.handle('start_download_hf', (_e, args) => startDownloadHf(args));
  ipcMain.handle('get_download_jobs', () => getDownloadJobs());
  ipcMain.handle('cancel_download_job', (_e, { jobId }) => cancelDownloadJob(jobId));
  ipcMain.handle('pause_download_job', (_e, { jobId }) => pauseDownloadJob(jobId));
  ipcMain.handle('clear_finished_downloads', () => clearFinishedDownloads());
  ipcMain.handle('remove_download_job', (_e, { id }) => removeDownloadJob(id));

  // ── RAG ──
  ipcMain.handle('ingest_document', (_e, { payload }) => ingestDocument(payload));
  ipcMain.handle('ingest_text', (_e, { payload }) => ingestText(payload));
  ipcMain.handle('ingest_text_fast', (_e, { payload }) => ingestTextFast(payload));
  ipcMain.handle('query_documents', (_e, { payload }) => queryDocuments(payload));
  ipcMain.handle('list_rag_documents', (_e, { payload }) => listRagDocuments(payload.chat_id));
  ipcMain.handle('remove_rag_document', (_e, { docId, payload }) => removeRagDocument(docId, payload.chat_id));
  ipcMain.handle('clear_rag_documents', (_e, { payload }) => clearRagDocuments(payload.chat_id));
  ipcMain.handle('has_rag_documents', (_e, { payload }) => hasRagDocuments(payload.chat_id));

  // ── Search ──
  ipcMain.handle('web_search', (_e, args) => webSearch(args, getMainWindow()));
  ipcMain.handle('ingest_search_context', (_e, { chatId, context, sources }) =>
    ingestSearchContext(chatId, context, sources));
  ipcMain.handle('fetch_model_catalog', () => fetchModelCatalog());
  ipcMain.handle('search_hf_models', (_e, { query, sort, limit }) => searchHfModels(query, sort, limit));
  ipcMain.handle('hf_repo_gguf', (_e, { repoId }) => hfRepoGguf(repoId));
  ipcMain.handle('open_url_window', (_e, { url }) => shell.openExternal(String(url || '')));

  ipcMain.handle('open_webviewer', (_e, { url, title }) => {
    if (!url || typeof url !== 'string') return { error: 'Invalid URL' };
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { error: 'Invalid URL scheme' };
    }
    try {
      createWebviewerWindow(url, title || 'Web Viewer');
      return { success: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('fetch_url_content', async (_e, { url, maxBytes }) => {
    try {
      return await scrapeUrlStructured({
        url,
        maxLength: maxBytes,
        timeoutMs: 15000,
        maxLinks: 150
      });
    } catch (err) {
      return { url: String(url), content: '', error: err instanceof Error ? err.message : String(err), status: 0 };
    }
  });
  ipcMain.handle('crawl_web', (_e, args) => crawlWeb(args));

  // ── Workspace / filesystem ──
  ipcMain.handle('path_exists', (_e, { path }) => pathExists(path));
  ipcMain.handle('open_models_folder', () => openModelsFolder());
  ipcMain.handle('pick_workspace_folder', () => pickWorkspaceFolder());
  ipcMain.handle('pick_model_file', () => pickModelFile());
  ipcMain.handle('index_workspace_folder', (_e, { path, chatId }) => indexWorkspaceFolder(path, chatId));
  ipcMain.handle('write_workspace_file', (_e, { workspaceRoot, relativePath, content }) =>
    writeWorkspaceFile(workspaceRoot, relativePath, content));
  ipcMain.handle('read_workspace_file', (_e, { workspaceRoot, relativePath }) =>
    readWorkspaceFile(workspaceRoot, relativePath));
  ipcMain.handle('create_workspace_document', (_e, { workspaceRoot, relativePath, docType, content }) =>
    createWorkspaceDocument(workspaceRoot, relativePath, docType, content));
  ipcMain.handle('rename_workspace_file', (_e, { workspaceRoot, oldPath, newPath }) =>
    renameWorkspaceFile(workspaceRoot, oldPath, newPath));
  ipcMain.handle('delete_workspace_file', (_e, { workspaceRoot, relativePath }) =>
    deleteWorkspaceFile(workspaceRoot, relativePath));
  ipcMain.handle('open_workspace_file', (_e, { absolutePath }) =>
    openWorkspaceFile(absolutePath));
  ipcMain.handle('create_workspace_folder', (_e, { workspaceRoot, relativePath }) =>
    createWorkspaceFolder(workspaceRoot, relativePath));
  ipcMain.handle('workspace_exec', (_e, payload) => workspaceExec(payload));
  ipcMain.handle('write_temp_file', (_e, { name, data }) => writeTempFile(name, data));
  ipcMain.handle('reset_media_permissions', () => resetMediaPermissions());

  // ── Agent tasks ──
  ipcMain.handle('agent_start_task', (_e, args) => agentStartTask(args));
  ipcMain.handle('agent_update_task', (_e, args) => agentUpdateTask(args));
  ipcMain.handle('agent_cancel_task', (_e, { taskId }) => agentCancelTask(taskId));
  ipcMain.handle('agent_get_task', (_e, { taskId }) => agentGetTask(taskId));
  ipcMain.handle('agent_list_tools', () => agentRunner.listTools());
  ipcMain.handle('agent_toggle_tool', (_e, { toolName, enabled }) => agentRunner.toggleTool(toolName, enabled));

  // ── Sandbox ──
  ipcMain.handle('sandbox_exec', (_e, args) => sandboxExec(args));

  // ── Browser control ──
  ipcMain.handle('browser_navigate', (_e, { url }) => browserNavigate(url));
  ipcMain.handle('browser_snapshot', () => browserSnapshot());
  ipcMain.handle('browser_click', (_e, { text }) => browserClick(text));
  ipcMain.handle('browser_type_text', (_e, { selector, text }) => browserTypeText(selector, text));
  ipcMain.handle('browser_evaluate', (_e, { script }) => browserEvaluate(script));
  ipcMain.handle('browser_screenshot', () => browserScreenshot());
  ipcMain.handle('browser_get_current_url', () => browserGetCurrentUrl());
  ipcMain.handle('browser_close', () => browserClose());

  // ── Slides ──
  ipcMain.handle('generate_pptx', (_e, { data }) => generatePptx(data));
  ipcMain.handle('save_pptx', (_e, { data, path }) => savePptx(data, path));
  ipcMain.handle('parse_slides_from_markdown', (_e, { markdown }) => parseSlidesFromMarkdown(markdown));
  ipcMain.handle('slides_to_markdown', (_e, { slides }) => slidesToMarkdown(slides));
}
