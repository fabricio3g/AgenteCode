import type { AppConfig, LocalThinkingMode, ModelOption, ProviderConfig } from '$lib/types/chat';

const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11435/v1';

export type ProviderUpdate = {
  provider: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  system_prompt?: string;
  extra_models?: string[];
};

export function mergeProviderConfig(
  config: AppConfig,
  partial: ProviderUpdate,
  opts: { activate?: boolean } = {}
): AppConfig {
  const existing: ProviderConfig = config.llm?.providers?.[partial.provider] || { base_url: '', model: '' };
  const hasApiKeyField = Object.prototype.hasOwnProperty.call(partial, 'api_key');
  const nextApiKey = hasApiKeyField
    ? (partial.api_key && partial.api_key.trim() ? partial.api_key : undefined)
    : (existing.api_key || undefined);

  return {
    ...config,
    llm: {
      ...config.llm,
      // Saving one provider's fields must not silently switch the active
      // route — activation is the toggle's job, not every field write's.
      ...(opts.activate === false ? {} : { provider: partial.provider }),
      providers: {
        ...(config.llm?.providers || {}),
        [partial.provider]: {
          ...existing,
          base_url: partial.base_url ?? existing.base_url,
          api_key: nextApiKey,
          has_api_key: !!(nextApiKey || existing.has_api_key),
          model: partial.model ?? existing.model,
          ...(Number.isFinite(partial.temperature) ? { temperature: partial.temperature } : partial.temperature === undefined ? {} : { temperature: undefined }),
          ...(partial.max_tokens !== undefined ? { max_tokens: partial.max_tokens || undefined } : {}),
          ...(Number.isFinite(partial.top_p) ? { top_p: partial.top_p } : partial.top_p === undefined ? {} : { top_p: undefined }),
          ...(partial.system_prompt !== undefined ? { system_prompt: partial.system_prompt || undefined } : {}),
          ...(partial.extra_models !== undefined ? { extra_models: partial.extra_models.filter(Boolean) } : {})
        }
      }
    }
  };
}

export function setBackendModeConfig(config: AppConfig, mode: 'local' | 'api'): AppConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      backend_mode: mode,
      local: {
        base_url: config.llm?.local?.base_url || DEFAULT_LOCAL_BASE_URL,
        ...(config.llm?.local || {})
      }
    }
  };
}

export function setLocalModelConfig(config: AppConfig, model: ModelOption): AppConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      backend_mode: 'local',
      local: {
        ...(config.llm?.local || {}),
        model: model.name,
        selected_model_path: model.path,
        base_url: config.llm?.local?.base_url || DEFAULT_LOCAL_BASE_URL
      }
    }
  };
}

export type LocalSettingsUpdate = {
  base_url?: string;
  runtime_path?: string;
  context_length?: number;
  gpu_layers?: number;
  cpu_threads?: number;
  batch_size?: number;
  flash_attention?: boolean;
  offload_kv_cache?: boolean;
  keep_in_memory?: boolean;
  mmap?: boolean;
  seed?: number | null;
  rope_freq_base?: number | null;
  rope_freq_scale?: number | null;
  parallel?: number | null;
  cache_type_k?: string;
  cache_type_v?: string;
  mmproj_path?: string;
  thinking_mode?: LocalThinkingMode;
  /** Legacy equivalent of thinking_mode 'off'; cleared on write. */
  disable_thinking?: boolean;
  mtp?: boolean;
  mtp_draft_path?: string | null;
  mtp_draft_n_max?: number | null;
  system_prompt?: string;
  temperature?: number;
  max_tokens?: number;
};

export function mergeLocalSettingsConfig(
  config: AppConfig,
  partial: LocalSettingsUpdate
): AppConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      local: {
        ...(config.llm?.local || {}),
        ...partial
      }
    }
  };
}

export function mergeUiSettingsConfig(
  config: AppConfig,
  partial: {
    show_assistant_text?: boolean;
    enable_thinking?: boolean;
    artifact_toggles?: Record<string, boolean>;
    composer_mode_control?: 'tabs' | 'auto';
    roleplay_enabled?: boolean;
    editor?: string;
  }
): AppConfig {
  return {
    ...config,
    ui: {
      ...(config.ui || {}),
      ...partial
    }
  };
}

export function mergePromptSettingsConfig(
  config: AppConfig,
  partial: {
    system_prompt?: string;
    user_prompt?: string;
    local_system_prompt?: string;
  }
): AppConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      ...(partial.system_prompt !== undefined ? { system_prompt: partial.system_prompt } : {}),
      ...(partial.user_prompt !== undefined ? { user_prompt: partial.user_prompt } : {}),
      local: {
        ...(config.llm?.local || {}),
        ...(partial.local_system_prompt !== undefined ? { system_prompt: partial.local_system_prompt } : {})
      }
    }
  };
}

export function mergeSearchSettingsConfig(
  config: AppConfig,
  partial: {
    provider?: string;
    max_results?: number;
    context_budget_chars?: number;
    aggregator_engines?: string[];
    safe_search?: number;
    providers?: NonNullable<AppConfig['search']>['providers'];
  }
): AppConfig {
  return {
    ...config,
    search: {
      ...(config.search || {}),
      ...partial,
      providers: {
        ...(config.search?.providers || {}),
        ...(partial.providers || {})
      }
    }
  };
}

export function mergeTtsSettingsConfig(
  config: AppConfig,
  partial: {
    enable_voice_output?: boolean;
    auto_play_voice?: boolean;
    voice?: string;
    speed?: number;
    volume?: number;
    engine?: 'kokoro' | 'wasm' | 'browser';
    model_path?: string;
    voices_path?: string;
    tokens_path?: string;
    lexicon_path?: string;
    dict_dir?: string;
    data_dir?: string;
    model_variant?: string;
    voice_model?: string;
    local_backend?: 'cpu' | 'vulkan';
    num_threads?: number;
    language?: string;
  }
): AppConfig {
  return {
    ...config,
    tts: {
      ...(config.tts || {}),
      ...partial
    }
  };
}
