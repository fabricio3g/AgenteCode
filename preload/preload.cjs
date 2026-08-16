const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_INVOKE_CHANNELS = new Set([
  'window:minimize', 'window:toggle-maximize', 'window:is-maximized', 'window:close', 'window:request-close', 'window:set-active-work',
  'get_hardware_limits', 'get_desktop_capabilities', 'get_runtime_recommendations', 'is_first_run',
  'get_config', 'save_config', 'update_config',
  'chat_db_save_session', 'chat_db_load_all', 'chat_db_delete', 'chat_db_migrate',
  'chat_db_load_folders', 'chat_db_save_folder', 'chat_db_delete_folder',
  'chat_db_load_code_projects', 'chat_db_save_code_project', 'chat_db_delete_code_project',
  'get_local_models', 'get_gguf_metadata', 'delete_local_model', 'get_models_dir_path',
  'get_indexed_models', 'refresh_model_index', 'invalidate_model_cache', 'import_local_model',
  'start_llama', 'stop_llama', 'get_supervisor_status', 'get_runtime_telemetry', 'supervisor_health_check',
  'start_embedding_server', 'stop_embedding_server', 'get_embedding_status',
  'get_loaded_models', 'unload_model', 'get_recommended_settings',
  'get_installed_runtimes', 'delete_runtime_binary', 'download_runtime',
  'generate_tts', 'generate_tts_stream', 'cancel_tts_stream', 'unload_tts', 'check_espeak_data', 'preload_tts', 'list_tts_voices', 'read_file_base64',
  'stt_transcribe', 'get_stt_status', 'unload_whisper',   'fetch_provider_models', 'get_api_model_context', 'detect_tool_support',
  'get_reasoning_capabilities',
  'get_whisper_runtimes', 'delete_whisper_runtime', 'download_whisper_runtime',
  'chat_complete', 'chat_stream_start', 'chat_stream_cancel',
  'count_tokens', 'build_context_budget', 'truncate_messages',
  'start_download_hf', 'get_download_jobs', 'cancel_download_job',
  'pause_download_job', 'clear_finished_downloads', 'remove_download_job',
  'ingest_document', 'ingest_text', 'ingest_text_fast', 'query_documents', 'list_rag_documents',
  'remove_rag_document', 'clear_rag_documents', 'has_rag_documents',
  'web_search', 'search:get-catalog', 'search:probe-engines',
  'ingest_search_context', 'fetch_model_catalog',
  'search_hf_models', 'hf_repo_gguf', 'open_url_window', 'open_webviewer',
  'live_get_weather', 'live_convert_currency', 'live_get_quote', 'live_geocode_place',

  'path_exists', 'open_models_folder', 'pick_workspace_folder', 'pick_model_file', 'pick_whisper_runtime_file',
  'index_workspace_folder', 'snapshot_workspace_files', 'write_workspace_file', 'read_workspace_file',
  'create_workspace_document', 'rename_workspace_file', 'delete_workspace_file',
  'open_workspace_file', 'create_workspace_folder', 'workspace_exec', 'write_temp_file',
  'reset_media_permissions',
  'agent_start_task', 'agent_update_task', 'agent_cancel_task', 'agent_get_task',
  'agent_list_tasks', 'agent_delete_task', 'agent_clear_history',

  'sandbox_exec',
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type_text',
  'browser_evaluate', 'browser_screenshot', 'browser_get_current_url', 'browser_close',
  'generate_pptx', 'save_pptx', 'parse_slides_from_markdown', 'slides_to_markdown',
  'generate_docx', 'generate_xlsx', 'generate_pdf',
  'fetch_url_content', 'crawl_web',
  'agente_detect', 'agente_start_session', 'agente_prompt',
  'agente_steer', 'agente_follow_up', 'agente_abort',
  'agente_compact', 'agente_set_model', 'agente_set_runtime_mode',
  'agente_respond_approval', 'agente_list_checkpoints', 'agente_rollback',
  'agente_close', 'agente_new_session', 'agente_cycle_model',
  'agente_list_sessions'
]);

const ALLOWED_EVENT_CHANNELS = new Set([
  'supervisor-event', 'download-progress', 'runtime-download-progress', 'whisper-runtime-download-progress',
  'search-result', 'search-progress', 'agent-event', 'tts-event', 'chat-stream-event',
  'tts-chunk', 'tts-done', 'tts-start',
  'code_agent_event'
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
  windowRequestClose: () => ipcRenderer.invoke('window:request-close'),
  windowSetActiveWork: (active, reasons = []) => ipcRenderer.invoke('window:set-active-work', { active, reasons }),

  // App info
  appName: 'Chatea',

  // Platform info
  platform: process.platform,
  isElectron: true
});
