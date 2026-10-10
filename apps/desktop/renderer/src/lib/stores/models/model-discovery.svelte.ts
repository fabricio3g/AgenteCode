import type { AppConfig, ModelOption } from '$lib/types/chat';
import { reasoningRouteIdentity } from '$lib/services/reasoning-route';

export interface ModelDiscoveryDeps {
  getConfig: () => AppConfig;
  isNative: () => boolean;
  cached: (config: AppConfig) => ModelOption[] | undefined;
  fetch: (config: AppConfig, force?: boolean) => Promise<ModelOption[]>;
  loadLocal: () => Promise<ModelOption[]>;
}

/** Owns the visible catalog and loading state, including overlapping refreshes. */
export class ModelDiscoveryController {
  models = $state<ModelOption[]>([]);
  refreshing = $state(false);
  private sequence = 0;
  constructor(private readonly deps: ModelDiscoveryDeps) {}

  private identity(config: AppConfig): string {
    const local = config.llm?.backend_mode === 'local' && this.deps.isNative();
    return reasoningRouteIdentity({ ...config, llm: { ...config.llm, backend_mode: local ? 'local' : 'api' } });
  }

  async refresh(force?: boolean): Promise<void> {
    const sequence = ++this.sequence;
    const config = this.deps.getConfig();
    const identity = this.identity(config);
    const current = () => sequence === this.sequence && identity === this.identity(this.deps.getConfig());
    const local = config.llm?.backend_mode === 'local' && this.deps.isNative();
    this.refreshing = true;
    this.models = local ? [] : this.deps.cached(config) ?? [];
    try {
      const models = local ? await this.deps.loadLocal() : await this.deps.fetch(config, force);
      if (current()) this.models = models;
    } catch {
      if (current()) this.models = [];
    } finally {
      if (sequence === this.sequence) this.refreshing = false;
    }
  }
}
