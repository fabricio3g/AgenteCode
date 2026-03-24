const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_INVOKE_CHANNELS = new Set([
  'window:minimize', 'window:toggle-maximize', 'window:is-maximized', 'window:close',
  'get_hardware_limits', 'get_desktop_capabilities',
  'get_config', 'save_config', 'update_config',
  'get_local_models', 'get_gguf_metadata', 'delete_local_model', 'get_models_dir_path',
  'get_indexed_models', 'refresh_model_index', 'invalidate_model_cache', 'import_local_model',
  'start_llama', 'stop_llama', 'get_supervisor_status', 'supervisor_health_check',
  'get_loaded_models', 'unload_model', 'get_recommended_settings',
  'get_installed_runtimes', 'delete_runtime_binary', 'download_runtime',
  'generate_tts', 'unload_tts', 'check_espeak_data',
  'stt_transcribe', 'get_stt_status', 'fetch_provider_models',
  'chat_complete', 'chat_stream_start', 'chat_stream_cancel',
  'start_download_hf', 'get_download_jobs', 'cancel_download_job',
  'pause_download_job', 'clear_finished_downloads', 'remove_download_job',
  'ingest_document', 'ingest_text', 'query_documents', 'list_rag_documents',
  'remove_rag_document', 'clear_rag_documents', 'has_rag_documents',
  'web_search', 'ingest_search_context', 'fetch_model_catalog',
  'search_hf_models', 'hf_repo_gguf', 'open_url_window', 'open_webviewer',
  'path_exists', 'open_models_folder', 'pick_workspace_folder', 'pick_model_file',
  'index_workspace_folder', 'write_workspace_file', 'read_workspace_file',
  'create_workspace_document', 'rename_workspace_file', 'delete_workspace_file',
  'open_workspace_file', 'create_workspace_folder', 'workspace_exec', 'write_temp_file',
  'reset_media_permissions',
  'agent_start_task', 'agent_update_task', 'agent_cancel_task', 'agent_get_task',
  'agent_list_tasks', 'agent_delete_task', 'agent_clear_history',
  'sandbox_exec',
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type_text',
  'browser_evaluate', 'browser_screenshot', 'browser_get_current_url', 'browser_close',
  'generate_pptx', 'save_pptx', 'parse_slides_from_markdown', 'slides_to_markdown'
]);

const ALLOWED_EVENT_CHANNELS = new Set([
  'supervisor-event', 'download-progress', 'runtime-download-progress',
  'search-result', 'search-progress', 'agent-event', 'tts-event', 'chat-stream-event'
]);

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => {
    if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  on: (channel, callback) => {
    if (!ALLOWED_EVENT_CHANNELS.has(channel)) return () => {};
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  once: (channel, callback) => {
    if (!ALLOWED_EVENT_CHANNELS.has(channel)) return;
    ipcRenderer.once(channel, (_event, ...args) => callback(...args));
  },

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  windowClose: () => ipcRenderer.invoke('window:close'),

  // Platform info
  platform: process.platform,
  isElectron: true
});
