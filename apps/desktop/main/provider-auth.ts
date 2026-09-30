// Provider credentials and cached configuration, shared by chat IPC and the Rust runtime.

import { loadConfigFromDisk } from './config.ts';
import { normalizeBaseUrl } from './providers/helpers.ts';
import { resolveLlamaSessionKey } from './llama-session.ts';

const _configCache = { data: null, ts: 0 };
const CONFIG_CACHE_TTL = 30_000;

export function getCachedConfig() {
  const now = Date.now();
  if (_configCache.data && now - _configCache.ts < CONFIG_CACHE_TTL) {
    return _configCache.data;
  }
  _configCache.data = loadConfigFromDisk();
  _configCache.ts = now;
  return _configCache.data;
}

type ProviderCredentials = { api_key?: string; base_url?: string };
type AuthConfig = { llm?: { provider?: string; providers?: Record<string, ProviderCredentials> } };

function configuredProviders(cfg: AuthConfig | null | undefined): Record<string, ProviderCredentials> {
  return cfg?.llm?.providers || {};
}

function namedKey(providers: Record<string, ProviderCredentials>, name?: string): string {
  if (!name) return '';
  return providers[name]?.api_key || '';
}

function urlKey(providers: Record<string, ProviderCredentials>, baseUrl?: string): string {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const match = Object.values(providers).find((provider) => normalizeBaseUrl(provider.base_url) === normalizedBase && !!provider.api_key);
  return match?.api_key || '';
}

function defaultKey(cfg: AuthConfig | null | undefined, providerName?: string): string {
  if (providerName) return '';
  return namedKey(configuredProviders(cfg), cfg?.llm?.provider);
}

export function resolveApiKeyFromConfig(cfg: AuthConfig | null | undefined, apiKey?: string, baseUrl?: string, providerName?: string): string {
  if (apiKey) return apiKey;
  const providers = configuredProviders(cfg);
  return namedKey(providers, providerName) || urlKey(providers, baseUrl) || defaultKey(cfg, providerName);
}

export function resolveApiKey(apiKey?: string, baseUrl?: string, providerName?: string): string {
  // The local llama-server is launched with a generated per-run --api-key that
  // is never written to config, so it has to be resolved from the live session.
  const sessionKey = resolveLlamaSessionKey(baseUrl);
  if (sessionKey) return sessionKey;
  return resolveApiKeyFromConfig(getCachedConfig(), apiKey, baseUrl, providerName);
}
