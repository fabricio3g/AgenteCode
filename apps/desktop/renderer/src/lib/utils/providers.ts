import type { AppConfig } from '$lib/types/chat';
import { DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_ID } from '$shared/providers';
import { providerDirectory, type CloudProviderMeta } from './provider-directory.svelte';

export type { CloudProviderMeta } from './provider-directory.svelte';

/**
 * Supported providers: the core's TOML specs, loaded through the daemon (see
 * provider-directory.svelte.ts; shared/providers.ts for why some services are
 * absent). Read inside a `$derived` to redraw when the directory arrives.
 */
export function cloudProviders(): CloudProviderMeta[] {
  return providerDirectory.providers;
}

export function providerMeta(id: string): CloudProviderMeta | undefined {
  return providerDirectory.providers.find((p) => p.id === id);
}

export function providerLabel(id: string): string {
  return providerMeta(id)?.label || id;
}

export function defaultBaseUrl(id: string): string {
  return providerMeta(id)?.defaultBaseUrl || DEFAULT_PROVIDER_BASE_URL;
}

export type ProviderSaved = {
  has_api_key?: boolean;
  api_key?: string;
  model?: string;
  base_url?: string;
  system_prompt?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
};

export type ConfiguredProviderInfo = {
  id: string;
  label: string;
  model?: string;
  baseUrl?: string;
  hasKey: boolean;
  isActive: boolean;
};

function providerHasKey(saved: ProviderSaved | undefined | null): boolean {
  if (!saved) return false;
  if (saved.has_api_key === true) return true;
  const key = String(saved.api_key || '').trim();
  if (!key) return false;
  // placeholders used in UI when key is redacted/saved
  if (key === '••••••••' || key === '•••••••••' || /^\u2022+$/.test(key)) return true;
  return key.length > 0;
}

function providerHasModel(saved: ProviderSaved | undefined | null): boolean {
  return !!String(saved?.model || '').trim();
}

/** True if this provider entry looks user-configured (key and/or model). */
export function isProviderConfigured(
  config: AppConfig | null | undefined,
  providerId: string
): boolean {
  const saved = config?.llm?.providers?.[providerId] as ProviderSaved | undefined;
  return providerHasKey(saved) || providerHasModel(saved);
}

/**
 * Providers available in the cloud model switcher.
 * Includes any provider with a saved key/model, plus the active provider when in API mode.
 */
export function configuredProviders(
  config: AppConfig | null | undefined,
  options?: { includeActiveAlways?: boolean }
): ConfiguredProviderInfo[] {
  const providers = (config?.llm?.providers || {}) as Record<string, ProviderSaved>;
  const active = String(config?.llm?.provider || DEFAULT_PROVIDER_ID);
  const includeActiveAlways = options?.includeActiveAlways !== false;
  const out: ConfiguredProviderInfo[] = [];
  const seen = new Set<string>();

  const consider = (id: string, force = false) => {
    if (seen.has(id)) return;
    const saved = providers[id];
    const hasKey = providerHasKey(saved);
    const hasModel = providerHasModel(saved);
    if (!force && !hasKey && !hasModel) return;
    seen.add(id);
    out.push({
      id,
      label: providerLabel(id),
      model: saved?.model || undefined,
      baseUrl: saved?.base_url || defaultBaseUrl(id),
      hasKey,
      isActive: id === active
    });
  };

  // Catalog order first
  for (const meta of cloudProviders()) {
    consider(meta.id);
  }
  // Any extra provider keys not in the catalog
  for (const id of Object.keys(providers)) {
    consider(id);
  }

  // Always surface the active provider in cloud mode so the menu is never empty
  // when the user is on API backend with a selected provider.
  if (includeActiveAlways && active) {
    consider(active, true);
  }

  // Active first
  out.sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.label.localeCompare(b.label));
  return out;
}
