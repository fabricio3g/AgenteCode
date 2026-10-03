import type { AppConfig, ChatModelSelection } from '$lib/types/chat';

export function homeRuntimeMatchesModel(runtime: { provider: string; model: string }, config: AppConfig): boolean {
  const llm = config.llm;
  const local = llm?.backend_mode === 'local';
  return runtime.provider === (local ? 'local' : llm?.provider)
    && runtime.model === (local ? llm?.local?.model : llm?.providers?.[llm?.provider || '']?.model);
}

/** Conversation choices contain identity only; credentials remain in config. */
export function captureChatModel(config: AppConfig, defaultBackendMode: 'api' | 'local' = 'api'): ChatModelSelection {
  const llm = config.llm;
  const provider = llm?.provider || '';
  return {
    backendMode: llm?.backend_mode || defaultBackendMode, provider,
    model: llm?.providers?.[provider]?.model || '',
    localModel: llm?.local?.model || '',
    localModelPath: llm?.local?.selected_model_path || '',
    localBaseUrl: llm?.local?.base_url || ''
  };
}

export function configForChatModel(config: AppConfig, selection?: ChatModelSelection | null): AppConfig {
  if (!selection) return config;
  const llm = config.llm;
  return {
    ...config, llm: {
      ...llm, backend_mode: selection.backendMode, provider: selection.provider,
      providers: {
        ...llm?.providers,
        ...(llm?.providers?.[selection.provider] ? {
          [selection.provider]: { ...llm.providers[selection.provider], model: selection.model }
        } : {})
      },
      local: { ...llm?.local, model: selection.localModel,
        selected_model_path: selection.localModelPath, base_url: selection.localBaseUrl || llm?.local?.base_url }
    }
  };
}
