// The cloud providers Agente supports, shared by main and the renderer.
//
// Only services whose terms let a person use their own key from a
// third-party app stay here. OpenAI, Anthropic, Gemini, Groq, Mistral,
// Together, Cohere and Perplexity were removed: each requires an agreement
// (or forbids sharing keys with) apps like this one.

/** Route used when the config names no provider. */
export const DEFAULT_PROVIDER_ID = 'openrouter';
export const DEFAULT_PROVIDER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Saved entries for these are dropped on load (see config.migrate.ts). */
export const REMOVED_PROVIDER_IDS: readonly string[] = [
  'openai', 'anthropic', 'gemini', 'groq', 'mistral', 'together', 'cohere', 'perplexity'
];
