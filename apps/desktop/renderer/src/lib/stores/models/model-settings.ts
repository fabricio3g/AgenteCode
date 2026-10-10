import type { AppConfig, ModelOption } from '$lib/types/chat';
import { mergeProviderConfig, mergeLocalSettingsConfig, setBackendModeConfig, setLocalModelConfig, type ProviderUpdate, type LocalSettingsUpdate } from '$lib/stores/app-store-config';

export interface ConfigCommitOptions {
  invalidateModels?: boolean;
  refreshModels?: boolean;
  refreshLocalStatus?: boolean;
  detectTools?: boolean;
}
export interface ModelSettingsDeps {
  getConfig: () => AppConfig;
  isNative: () => boolean;
  commit: (next: AppConfig, options?: ConfigCommitOptions) => Promise<void>;
}

/** Provider/model configuration commands; conversation ownership and persistence stay at the host boundary. */
export class ModelSettingsController {
  constructor(private readonly deps: ModelSettingsDeps) {}
  async updateProvider(partial: ProviderUpdate, opts: { activate?: boolean } = {}) {
    const config = this.deps.getConfig();
    const previous = config.llm?.providers?.[partial.provider];
    const credentialsChanged = partial.api_key !== undefined
      || (partial.base_url !== undefined && partial.base_url !== previous?.base_url);
    const next = mergeProviderConfig(config, partial, opts);
    await this.deps.commit(next, {
      invalidateModels: credentialsChanged,
      refreshModels: true,
      detectTools: true,
      refreshLocalStatus: next.llm?.backend_mode === 'local'
    });
  }

  /**
   * Register a user-added OpenAI-compatible endpoint. The key and model are
   * stored through updateProvider under llm.providers[id] as usual; only the
   * directory entry lives in llm.custom_providers.
   */
  async addCustomProvider(input: { label: string; base_url: string }): Promise<string> {
    const config = this.deps.getConfig();
    const slug = input.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
    const existing = config.llm?.custom_providers ?? [];
    let id = `custom-${slug}`;
    let n = 2;
    while (existing.some((p) => p.id === id)) id = `custom-${slug}-${n++}`;
    await this.deps.commit({
      ...config,
      llm: { ...config.llm, custom_providers: [...existing, { id, label: input.label.trim(), base_url: input.base_url.trim() }] }
    }, { refreshModels: false });
    return id;
  }

  /** Remove a custom endpoint and its stored credential/model entry. */
  async removeCustomProvider(id: string): Promise<void> {
    const config = this.deps.getConfig();
    const list = (config.llm?.custom_providers ?? []).filter((p) => p.id !== id);
    const providers = { ...(config.llm?.providers ?? {}) };
    delete providers[id];
    const wasActive = config.llm?.provider === id;
    await this.deps.commit({
      ...config,
      llm: {
        ...config.llm,
        custom_providers: list,
        providers,
        ...(wasActive ? { provider: '' } : {})
      }
    }, { refreshModels: true, invalidateModels: true });
  }

  async setBackendMode(mode: 'local' | 'api') {
    const config = this.deps.getConfig();
    const current = config.llm?.backend_mode || (this.deps.isNative() ? 'local' : 'api');
    if (current === mode) return;
    await this.deps.commit(setBackendModeConfig(config, mode), {
      refreshModels: true,
      detectTools: true,
      refreshLocalStatus: true
    });
  }

  /**
   * Point chats at a provider id ('' = none active) without touching its
   * stored fields — the settings toggle's primitive.
   */
  async setActiveProvider(id: string) {
    const config = this.deps.getConfig();
    await this.deps.commit({
      ...config,
      llm: { ...config.llm, provider: id }
    }, { refreshModels: true, detectTools: true });
  }

  async updateLocalModel(model: ModelOption) {
    const config = this.deps.getConfig();
    await this.deps.commit(setLocalModelConfig(config, model), {
      refreshModels: true,
      detectTools: true,
      refreshLocalStatus: true
    });
  }

  async updateLocalSettings(partial: LocalSettingsUpdate) {
    const config = this.deps.getConfig();
    await this.deps.commit(mergeLocalSettingsConfig(config, partial), {
      refreshLocalStatus: true
    });
  }

}
