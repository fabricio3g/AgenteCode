import { ipcMain, shell, net } from 'electron';
import { getMainWindow, createWebviewerWindow, requestMainWindowClose, setActiveWorkState } from './index.js';
import { loadConfig, saveConfig, updateConfig, redactConfig, loadConfigFromDisk } from './config.js';
import { getHardwareLimits } from './hardware.js';
import {
  getLocalModels, getGgufMetadata, deleteLocalModel, getModelsDirPath,
  getIndexedModels, refreshModelIndex, invalidateModelCache, importLocalModel
} from './model-manager.js';
import {
  startLlama, stopLlama, getInstalledRuntimes, deleteRuntimeBinary,
  getSupervisorStatus, supervisorHealthCheck, getLoadedModels,
  unloadModel, getRecommendedSettings
} from './llm-runner.js';
import { generateTts, unloadTts, checkEspeakData } from './tts-engine.js';
import { transcribeAudio, getSttStatus, unloadWhisper } from './stt-engine.js';
import {
  startDownloadHf, getDownloadJobs, cancelDownloadJob,
  pauseDownloadJob, clearFinishedDownloads, removeDownloadJob
} from './download-manager.js';
import {
  ingestDocument, ingestText, queryDocuments,
  listRagDocuments, removeRagDocument, clearRagDocuments, hasRagDocuments
} from './rag-engine.js';
import {
  webSearch, ingestSearchContext, fetchModelCatalog,
  searchHfModels, hfRepoGguf
} from './search-engine.js';
import {
  pathExists, openModelsFolder, pickWorkspaceFolder, pickModelFile,
  indexWorkspaceFolder, writeWorkspaceFile, readWorkspaceFile,
  createWorkspaceDocument, renameWorkspaceFile, deleteWorkspaceFile,
  openWorkspaceFile, createWorkspaceFolder, workspaceExec, writeTempFile,
  resetMediaPermissions, downloadRuntime
} from './workspace.js';
import {
  agentStartTask, agentUpdateTask, agentCancelTask,
  agentGetTask, agentListTasks, agentDeleteTask, agentClearHistory
} from './agent-manager.js';
import { sandboxExec } from './sandbox.js';
import {
  browserNavigate, browserSnapshot, browserClick, browserTypeText,
  browserEvaluate, browserScreenshot, browserGetCurrentUrl, browserClose
} from './browser-control.js';
import {
  generatePptx, savePptx, parseSlidesFromMarkdown, slidesToMarkdown
} from './slides.js';
import { completeChatRequest, startChatStream, cancelChatStream } from './chat-ipc.js';

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
  ipcMain.handle('get_recommended_settings', (_e, { modelPath, userContext, userGpuLayers }) =>
    getRecommendedSettings(modelPath, userContext, userGpuLayers));

  // ── Runtimes ──
  ipcMain.handle('get_installed_runtimes', () => getInstalledRuntimes());
  ipcMain.handle('delete_runtime_binary', (_e, { path }) => deleteRuntimeBinary(path));
  ipcMain.handle('download_runtime', (_e, { payload }) => downloadRuntime(payload, getMainWindow()));

  // ── TTS ──
  ipcMain.handle('generate_tts', (_e, { request }) => generateTts(request));
  ipcMain.handle('unload_tts', () => unloadTts());
  ipcMain.handle('check_espeak_data', (_e, { modelsDir }) => checkEspeakData(modelsDir));

  // ── STT (speech-to-text) ──
  ipcMain.handle('stt_transcribe', (_e, args) => transcribeAudio(args));
  ipcMain.handle('get_stt_status', () => getSttStatus());
  ipcMain.handle('unload_whisper', () => unloadWhisper());

  // ── Provider model list (main process fetch avoids renderer CORS) ──
  ipcMain.handle('fetch_provider_models', async (_e, { baseUrl, apiKey, providerName }) => {
    // Resolve real API key from disk config.
    // Prefer lookup by providerName (exact), fall back to URL matching.
    let realKey = apiKey;
    if (!realKey) {
      const diskConfig = loadConfigFromDisk();
      const providers = diskConfig?.llm?.providers || {};
      if (providerName && providers[providerName]?.api_key) {
        realKey = providers[providerName].api_key;
      } else {
        // Fallback: try default provider
        const defaultProvider = diskConfig?.llm?.provider;
        if (defaultProvider && defaultProvider !== providerName && providers[defaultProvider]?.api_key) {
          realKey = providers[defaultProvider].api_key;
        } else {
          // Fallback: match by base_url (strip trailing slashes for comparison)
          const normalizedBase = String(baseUrl || '').replace(/\/+$/, '');
          for (const provider of Object.values(providers)) {
            if (String(provider.base_url || '').replace(/\/+$/, '') === normalizedBase && provider.api_key) {
              realKey = provider.api_key;
              break;
            }
          }
        }
      }
    }
    if (!realKey) {
      throw new Error(`No API key configured for ${providerName || 'the selected provider'}. Please add your API key in Settings > LLM Providers.`);
    }
    const url = `${String(baseUrl || '').replace(/\/+$/, '')}/models`;
    const headers = { 'Accept': 'application/json' };
    if (realKey) headers['Authorization'] = `Bearer ${realKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const list = data?.data ?? data?.models ?? [];
    return list.map((m) => m.id).filter(Boolean).sort();
  });

  // ── Chat (main-process network for API key safety) ──
  ipcMain.handle('chat_complete', (_e, args) => completeChatRequest(args));
  ipcMain.handle('chat_stream_start', (_e, args) => startChatStream(args, getMainWindow()));
  ipcMain.handle('chat_stream_cancel', (_e, args) => cancelChatStream(args));

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
      const targetUrl = String(url || '');
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        return { url: targetUrl, content: '', error: 'Invalid URL scheme', status: 400 };
      }
      const request = net.request(targetUrl);
      request.setHeader('User-Agent', 'Mozilla/5.0 (compatible; TalamoLM/1.0)');
      request.setHeader('Accept', 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8');
      return new Promise((resolve) => {
        let body = '';
        let status = 0;
        const maxLen = Math.min(Math.max(Number(maxBytes) || 50000, 1000), 200000);
        request.on('response', (response) => {
          status = response.statusCode;
          response.on('data', (chunk) => {
            if (body.length < maxLen) body += chunk.toString('utf8');
          });
          response.on('end', () => {
            const content = body.slice(0, maxLen);
            resolve({ url: targetUrl, content, status, truncated: body.length > maxLen });
          });
        });
        request.on('error', (err) => {
          resolve({ url: targetUrl, content: '', error: err.message, status: 0 });
        });
        setTimeout(() => {
          request.abort();
          resolve({ url: targetUrl, content: '', error: 'Request timed out', status: 408 });
        }, 15000);
        request.end();
      });
    } catch (err) {
      return { url: String(url), content: '', error: err instanceof Error ? err.message : String(err), status: 0 };
    }
  });

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
  ipcMain.handle('agent_list_tasks', (_e, { chatId }) => agentListTasks(chatId));
  ipcMain.handle('agent_delete_task', (_e, { taskId }) => agentDeleteTask(taskId));
  ipcMain.handle('agent_clear_history', (_e, { chatId }) => agentClearHistory(chatId));

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
