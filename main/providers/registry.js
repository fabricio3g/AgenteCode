import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { GroqProvider } from './groq.js';
import { MistralProvider } from './mistral.js';
import { OpenRouterProvider } from './openrouter.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { LocalProvider } from './local.js';

const providers = [
  new AnthropicProvider(),          // Check first (URL-based detection)
  new GeminiProvider(),             // Gemini-specific API format
  new GroqProvider(),               // Hostname detection
  new OpenRouterProvider(),         // OpenRouter SDK
  new MistralProvider(),            // Hostname detection
  new OpenAIProvider(),             // Official OpenAI
  new LocalProvider(),              // localhost/127.0.0.1
  new OpenAICompatibleProvider(),   // Fallback — always matches
];

export function resolveProvider(providerName, baseUrl) {
  for (const p of providers) {
    if (p.detect(providerName, baseUrl)) return p;
  }
  // Should never reach here since OpenAICompatibleProvider always matches
  return providers[providers.length - 1];
}
