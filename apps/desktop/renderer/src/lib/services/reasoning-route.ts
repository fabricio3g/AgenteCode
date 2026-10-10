import type { AppConfig } from '$lib/types/chat';
import { DEFAULT_PROVIDER_ID } from '$shared/providers';

/**
 * Identity of the route a reasoning-capabilities probe belongs to. The store
 * skips re-probing when the identity is unchanged, so every settings save
 * doesn't hit the provider catalog — and a stale probe can never pass as
 * the current route's levels after a backend/provider/model switch.
 */
export function reasoningRouteIdentity(config: AppConfig | null | undefined): string {
  const backendMode = config?.llm?.backend_mode || 'local';
  if (backendMode === 'local') {
    const local = config?.llm?.local || {};
    return `local:${local.model || ''}:${local.selected_model_path || ''}`;
  }
  const providerName = config?.llm?.provider || DEFAULT_PROVIDER_ID;
  const provider = (config?.llm?.providers?.[providerName] || {}) as { base_url?: string; model?: string };
  return `api:${providerName}:${provider.base_url || ''}:${provider.model || ''}`;
}

