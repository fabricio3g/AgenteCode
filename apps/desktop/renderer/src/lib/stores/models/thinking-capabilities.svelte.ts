import type { AppConfig, ReasoningCapabilities } from '$lib/types/chat';
import { reasoningRouteIdentity } from '$lib/services/reasoning-route';
import { DEFAULT_PROVIDER_ID } from '$shared/providers';

export type ThinkingQuery = { providerName: string; model: string; modelPath?: string; baseUrl?: string; apiKey?: string };
export interface ThinkingCapabilitiesDeps {
  getConfig: () => AppConfig;
  isNative: () => boolean;
  fetch: (query: ThinkingQuery) => Promise<ReasoningCapabilities>;
  onResolved?: (capabilities: ReasoningCapabilities) => void;
}
const unknown = (): ReasoningCapabilities => ({ supported: false, levels: [], source: 'unknown' });

/** The route supplies its own capabilities; local preferences never enter a cloud query. */
export function thinkingQuery(config: AppConfig, native: boolean): ThinkingQuery {
  const mode = config.llm?.backend_mode || (native ? 'local' : 'api');
  if (mode === 'local') {
    return { providerName: 'local', model: config.llm?.local?.model || 'local-model', modelPath: config.llm?.local?.selected_model_path || '' };
  }
  const providerName = config.llm?.provider || DEFAULT_PROVIDER_ID;
  const provider = config.llm?.providers?.[providerName];
  return { providerName, model: provider?.model || '', baseUrl: provider?.base_url, apiKey: provider?.api_key };
}

/** Owns capability freshness and cancellation, independent of app and conversation stores. */
export class ThinkingCapabilitiesController {
  capabilities = $state<ReasoningCapabilities>(unknown());
  private key = '';
  private sequence = 0;
  constructor(private readonly deps: ThinkingCapabilitiesDeps) {}

  cancel(): void { this.sequence++; }

  async refresh(force = false): Promise<void> {
    const sequence = ++this.sequence;
    if (!this.deps.isNative()) { this.capabilities = unknown(); return; }
    const config = this.deps.getConfig();
    const identity = reasoningRouteIdentity(config);
    if (!force && identity === this.key && this.capabilities.source !== 'unknown') return;
    if (identity !== this.key) this.capabilities = unknown();
    try {
      const capabilities = await this.deps.fetch(thinkingQuery(config, true));
      if (sequence !== this.sequence || identity !== reasoningRouteIdentity(this.deps.getConfig())) return;
      this.key = identity;
      this.capabilities = { ...capabilities, route: identity };
      this.deps.onResolved?.(this.capabilities);
    } catch {
      // A same-route failure retains its profile; a changed route stays unknown.
    }
  }
}
