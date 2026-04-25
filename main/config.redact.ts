/**
 * Configuration redaction utilities.
 * Removes sensitive data (API keys) before sending config to renderer.
 */

import type { AppConfig, LLMProviderConfig } from './config.types.ts';

/**
 * Redacted provider configuration (API key removed).
 */
export interface RedactedProviderConfig extends Omit<LLMProviderConfig, 'api_key'> {
  has_api_key: boolean;
}

/**
 * Redacted LLM configuration.
 */
export interface RedactedLLMConfig {
  backend_mode: string;
  provider: string;
  system_prompt: string;
  user_prompt: string;
  local: unknown;
  providers: Record<string, RedactedProviderConfig>;
}

/**
 * Redacted application configuration.
 */
export interface RedactedAppConfig extends Omit<AppConfig, 'llm'> {
  llm: RedactedLLMConfig;
}

/**
 * Redacts a single provider's API key.
 * @param provider - Provider config to redact
 * @returns Redacted provider with has_api_key flag
 */
export function redactProvider(provider: LLMProviderConfig): RedactedProviderConfig {
  const { api_key, ...rest } = provider;
  return {
    ...rest,
    has_api_key: Boolean(api_key && api_key.length > 0),
  };
}

/**
 * Redacts all provider API keys in LLM config.
 * @param llm - LLM config section
 * @returns Redacted LLM config
 */
export function redactLLMConfig(llm: AppConfig['llm']): RedactedLLMConfig {
  const providers: Record<string, RedactedProviderConfig> = {};
  
  if (llm?.providers) {
    for (const [name, provider] of Object.entries(llm.providers)) {
      if (provider && typeof provider === 'object') {
        providers[name] = redactProvider(provider as LLMProviderConfig);
      }
    }
  }

  return {
    backend_mode: llm?.backend_mode ?? 'api',
    provider: llm?.provider ?? '',
    system_prompt: llm?.system_prompt ?? '',
    user_prompt: llm?.user_prompt ?? '',
    local: llm?.local,
    providers,
  };
}

/**
 * Redacts sensitive data from the full config.
 * Removes API keys and replaces with has_api_key boolean flags.
 * @param cfg - Full application config
 * @returns Redacted config safe for renderer
 */
export function redactConfig(cfg: AppConfig): RedactedAppConfig {
  // Deep clone to avoid mutating original
  const cloned = structuredClone(cfg) as AppConfig;
  
  // Redact LLM providers
  const redactedLLM = redactLLMConfig(cloned.llm);

  // Return redacted config
  return {
    ...cloned,
    llm: redactedLLM,
  };
}

/**
 * Checks if a provider has an API key configured.
 * @param provider - Provider config to check
 * @returns true if API key exists and is non-empty
 */
export function hasApiKey(provider: LLMProviderConfig): boolean {
  return Boolean(provider?.api_key && provider.api_key.length > 0);
}

/**
 * Gets count of providers with configured API keys.
 * @param cfg - Application config
 * @returns Number of providers with API keys
 */
export function countApiKeys(cfg: AppConfig): number {
  const providers = cfg?.llm?.providers ?? {};
  let count = 0;
  for (const provider of Object.values(providers)) {
    if (provider && typeof provider === 'object' && hasApiKey(provider as LLMProviderConfig)) {
      count++;
    }
  }
  return count;
}