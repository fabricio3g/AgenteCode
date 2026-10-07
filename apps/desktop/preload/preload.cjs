const { contextBridge, ipcRenderer, webFrame } = require('electron');

const ALLOWED_INVOKE_CHANNELS = new Set([
  'desktop_renderer_ready',
  'browser_chat_ready', 'browser_chat_reply',
  'domains_status', 'domains_config', 'domains_set_enabled', 'domains_pick_runtime', 'domains_projects', 'domains_project', 'domains_import', 'domains_preview', 'domains_jobs', 'domains_cancel', 'domains_call',
  'window:open-conversation', 'window:minimize', 'window:toggle-maximize', 'window:is-maximized', 'window:close', 'window:request-close', 'window:set-active-work',
  'get_hardware_limits', 'get_desktop_capabilities', 'get_runtime_recommendations', 'is_first_run',
  'get_config', 'save_config', 'update_config',
  'chat_db_save_draft', 'chat_db_save_session', 'chat_db_load_all', 'chat_db_delete', 'chat_db_migrate',
  'chat_db_load_folders', 'chat_db_save_folder', 'chat_db_delete_folder',
  'chat_db_load_code_projects', 'chat_db_save_code_project', 'chat_db_delete_code_project',
  'chat_db_load_characters', 'chat_db_save_character', 'chat_db_delete_character',
  'chat_db_load_personas', 'chat_db_save_persona', 'chat_db_delete_persona',
  'chat_db_load_worlds', 'chat_db_save_world', 'chat_db_delete_world',
  'chat_db_search_content',
  'get_local_models', 'get_gguf_metadata', 'delete_local_model', 'get_models_dir_path',
  'get_indexed_models', 'refresh_model_index', 'invalidate_model_cache', 'import_local_model',
  'start_llama', 'stop_llama', 'get_supervisor_status', 'get_runtime_telemetry', 'supervisor_health_check',
  'start_embedding_server', 'stop_embedding_server', 'get_embedding_status',
  'get_loaded_models', 'unload_model', 'get_recommended_settings', 'preview_local_model_command',
  'get_installed_runtimes', 'delete_runtime_binary', 'download_runtime',
  'generate_tts', 'generate_tts_stream', 'cancel_tts_stream', 'unload_tts', 'check_espeak_data', 'preload_tts', 'list_tts_voices', 'list_speech_voices', 'read_file_base64',
  'stt_transcribe', 'preload_whisper', 'get_stt_status', 'unload_whisper', 'voice_setup_plan', 'setup_voice', 'list_speech_models', 'use_speech_model', 'remove_speech_model', 'get_engine_overview', 'list_instances', 'start_instance', 'stop_instance', 'set_instance_sharing', 'get_instance_key', 'check_whisper_update', 'update_whisper_engine', 'list_whisper_releases', 'cleanup_engines', 'open_data_folder',   'fetch_provider_models', 'test_provider_connection', 'get_api_model_context', 'detect_tool_support',
  'get_reasoning_capabilities', 'list_provider_specs',
  'get_whisper_runtimes', 'delete_whisper_runtime', 'download_whisper_runtime',
  'chat_complete', 'chat_stream_start', 'chat_stream_cancel',
  'count_tokens', 'build_context_budget', 'truncate_messages',
  'start_download_hf', 'get_download_jobs', 'cancel_download_job',
  'pause_download_job', 'clear_finished_downloads', 'remove_download_job',
  'ingest_document', 'ingest_text', 'ingest_text_fast', 'query_documents', 'list_rag_documents',
  'remove_rag_document', 'clear_rag_documents', 'has_rag_documents',
  'files_list', 'files_get', 'files_refs', 'files_pin', 'files_stats', 'files_trash',
  'web_search', 'search:get-catalog', 'search:probe-engines',
  'ingest_search_context', 'fetch_model_catalog',
  'search_hf_models', 'hf_repo_gguf', 'fetch_hf_readme', 'open_url_window', 'open_webviewer',
  'live_get_weather', 'live_convert_currency', 'live_get_quote', 'live_geocode_place',

  'path_exists', 'open_models_folder', 'pick_workspace_folder', 'pick_model_file', 'pick_whisper_runtime_file',
  'index_workspace_folder', 'snapshot_workspace_files', 'write_workspace_file', 'write_workspace_binary', 'read_workspace_file', 'read_workspace_binary',
  'create_workspace_document', 'rename_workspace_file', 'delete_workspace_file',
  'open_workspace_file', 'create_workspace_folder', 'workspace_exec', 'write_temp_file',
  'reset_media_permissions', 'clipboard_write',
  'agent_start_task', 'agent_update_task', 'agent_cancel_task', 'agent_get_task',
  'agent_list_tasks', 'agent_delete_task', 'agent_clear_history',
  'browser_agent_action', 'browser_takeover', 'browser_history', 'browser_get_state', 'browser_select_scope', 'browser_open_tab', 'browser_list_tabs', 'browser_set_active', 'browser_close_tab',
  'browser_close_all', 'browser_panel_visible', 'browser_panel_occluded', 'browser_panel_bounds', 'browser_panel_presentation', 'browser_viewport',
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type_text',
  'browser_evaluate', 'browser_screenshot', 'browser_pick_element', 'browser_pick_cancel', 'browser_get_current_url', 'browser_close',
  'generate_pptx', 'parse_slides_from_markdown', 'slides_to_markdown',
  'generate_docx', 'generate_xlsx', 'generate_pdf',
  'fetch_url_content', 'crawl_web',
  'home_runtime_start', 'home_runtime_result', 'home_runtime_cancel', 'home_runtime_update', 'home_runtime_steer',
  'agente_start_session', 'agente_prompt',
  'agente_steer', 'agente_follow_up', 'agente_abort',
  'agente_compact', 'model_sees_images', 'agente_set_model', 'agente_set_runtime_mode',
  'agente_respond_approval', 'agente_list_checkpoints', 'agente_rollback',
  'agente_delete_session_data', 'agente_live_chats',
  'bots_list', 'bots_get', 'bots_create', 'bots_update', 'bots_delete', 'bots_write_doc', 'bots_compact',
  'bots_history', 'bots_cancel', 'bots_chat', 'bots_respond_approval', 'bots_toolsets', 'bots_sandbox',
  'bots_telegram', 'bots_telegram_connect', 'bots_telegram_disconnect', 'bots_telegram_pair', 'bots_telegram_unpair',
  'routines_list', 'routines_save', 'routines_delete', 'routines_run_now',
  'voice_models_status', 'voice_model_download', 'voice_model_delete', 'voice_engine_restart', 'voice_catalog', 'voice_clone_save', 'voice_clone_delete',
  'terminal_create', 'terminal_write', 'terminal_resize', 'terminal_kill',
  'agente_process_list', 'agente_process_output', 'agente_process_start', 'agente_process_stop', 'agente_process_clear',
  'agente_changes', 'agente_file_diff', 'agente_revert_file',
  'agente_git_branches', 'agente_git_switch_branch', 'agente_open_in_editor', 'agente_reveal_path', 'agente_trash_path',
   'agente_exec', 'agente_undo', 'agente_redo', 'agente_project_info', 'agente_project_init', 'agente_mcp_status', 'agente_project_files',
   'agente_message_action', 'agente_session_snapshot', 'agente_session_list', 'agente_session_history', 'agente_runtime_configure', 'agente_runtime_settings', 'agente_model_inputs', 'agente_child_cancel', 'agente_subagent_model', 'agente_media_import', 'agente_media_preview', 'agente_mcp_control'
]);

const ALLOWED_EVENT_CHANNELS = new Set([
  'domain_job',
  'supervisor-event', 'download-progress', 'runtime-download-progress', 'whisper-runtime-download-progress', 'voice-setup-progress', 'instances-changed',
  'search-result', 'search-progress', 'agent-event', 'tts-event', 'chat-stream-event',
  'tts-chunk', 'tts-done', 'tts-start', 'tts-error',
  'home_runtime_event', 'code_agent_event', 'browser_panel_state', 'code_process_event', 'terminal_event', 'bot_event', 'browser_chat_request',
  'ui-zoom'
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
  // Repaint the OS caption buttons when the theme flips. No-ops on macOS,
  // which has no overlay — it keeps the real traffic lights instead.
  windowSetTitlebarOverlay: (overlay) => ipcRenderer.invoke('window:set-titlebar-overlay', {
    color: typeof overlay?.color === 'string' ? overlay.color : '',
    symbolColor: typeof overlay?.symbolColor === 'string' ? overlay.symbolColor : ''
  }),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowRequestClose: () => ipcRenderer.invoke('window:request-close'),
  windowSetActiveWork: (active, reasons = []) => ipcRenderer.invoke('window:set-active-work', { active, reasons }),

  // Interface size (Settings → Accessibility, and Ctrl +/-/0)
  getZoomFactor: () => webFrame.getZoomFactor(),
  setZoomFactor: (factor) => {
    const value = Number(factor);
    if (Number.isFinite(value) && value >= 0.5 && value <= 3) webFrame.setZoomFactor(value);
  },

  // App info
  appName: 'Agente', // mirrors shared/brand.ts

  // Platform info
  platform: process.platform,
  isElectron: true
});

// Resource failures can occur before the renderer module graph runs.
window.addEventListener('error', (event) => {
  if (document.documentElement.dataset.desktopReady) return;
  const script = event.target && event.target.tagName === 'SCRIPT';
  if (script || event.message) ipcRenderer.send('desktop_bootstrap_error', script ? 'Renderer script failed to load' : String(event.message).slice(0, 2000));
}, true);
