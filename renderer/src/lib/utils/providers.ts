import type { AppConfig } from '$lib/types/chat';

export type CloudProviderMeta = {
  id: string;
  label: string;
  defaultBaseUrl: string;
  group: 'cloud' | 'local';
};

export const CLOUD_PROVIDERS: CloudProviderMeta[] = [
  { id: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', group: 'cloud' },
  { id: 'openrouter', label: 'OpenRouter', defaultBaseUrl: 'https://openrouter.ai/api/v1', group: 'cloud' },
  { id: 'anthropic', label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com', group: 'cloud' },
  { id: 'groq', label: 'Groq', defaultBaseUrl: 'https://api.groq.com', group: 'cloud' },
  { id: 'gemini', label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com', group: 'cloud' },
  { id: 'mistral', label: 'Mistral AI', defaultBaseUrl: 'https://api.mistral.ai/v1', group: 'cloud' },
  { id: 'together', label: 'Together AI', defaultBaseUrl: 'https://api.together.xyz/v1', group: 'cloud' },
  { id: 'deepseek', label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1', group: 'cloud' },
  { id: 'cohere', label: 'Cohere', defaultBaseUrl: 'https://api.cohere.ai/compatibility/v1', group: 'cloud' },
  { id: 'perplexity', label: 'Perplexity', defaultBaseUrl: 'https://api.perplexity.ai', group: 'cloud' },
  { id: 'lmstudio', label: 'LM Studio', defaultBaseUrl: 'http://localhost:1234/v1', group: 'local' },
  { id: 'ollama', label: 'Ollama', defaultBaseUrl: 'http://localhost:11434/v1', group: 'local' },
  { id: 'custom', label: 'Custom / Other', defaultBaseUrl: 'https://api.openai.com/v1', group: 'local' }
];

export const PROVIDER_URLS: Record<string, string> = Object.fromEntries(
  CLOUD_PROVIDERS.map((p) => [p.id, p.defaultBaseUrl])
);

export const PROVIDER_DOCS: Record<string, string> = {
  openai: 'https://developers.openai.com/api/docs/guides/reasoning',
  anthropic: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking',
  gemini: 'https://ai.google.dev/gemini-api/docs/function-calling',
  groq: 'https://console.groq.com/docs/reasoning',
  openrouter: 'https://openrouter.ai/docs/guides/best-practices/reasoning-tokens',
  mistral: 'https://docs.mistral.ai/studio/conversations/function-calling',
  deepseek: 'https://api-docs.deepseek.com/guides/thinking_mode/',
  together: 'https://docs.together.ai/docs/reasoning-overview',
  cohere: 'https://docs.cohere.com/docs/compatibility-api',
  perplexity: 'https://docs.perplexity.ai/docs/sonar/quickstart',
  lmstudio: 'https://lmstudio.ai/docs/developer/openai-compat/tools',
  ollama: 'https://docs.ollama.com/api/openai-compatibility'
};

export const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  CLOUD_PROVIDERS.map((p) => [p.id, p.label])
);

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] || id;
}

export function defaultBaseUrl(id: string): string {
  return PROVIDER_URLS[id] || 'https://api.openai.com/v1';
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
  const active = String(config?.llm?.provider || 'openai');
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
  for (const meta of CLOUD_PROVIDERS) {
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

/** Brand-ish accent per provider for settings avatars. */
export const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f',
  openrouter: '#7c7cf4',
  anthropic: '#d97757',
  groq: '#f55036',
  gemini: '#4788f4',
  mistral: '#ff7000',
  deepseek: '#4d6bfe',
  together: '#0f6fff',
  cohere: '#39594d',
  perplexity: '#20808d',
  lmstudio: '#5b6ee1',
  ollama: '#6b7280',
  local: '#e8734a',
  custom: '#64748b'
};
