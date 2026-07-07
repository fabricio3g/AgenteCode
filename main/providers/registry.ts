import { OpenAIProvider } from './openai.ts';
import { AnthropicProvider } from './anthropic.ts';
import { GeminiProvider } from './gemini.ts';
import { GroqProvider } from './groq.ts';
import { MistralProvider } from './mistral.ts';
import { OpenRouterProvider } from './openrouter.ts';
import { DeepSeekProvider } from './deepseek.ts';
import { OpenAICompatibleProvider } from './openai-compatible.ts';
import { LocalProvider } from './local.ts';

const providers = [
  new AnthropicProvider(),          // Check first (URL-based detection)
  new GeminiProvider(),             // Gemini-specific API format
  new GroqProvider(),               // Hostname detection
  new OpenRouterProvider(),         // OpenRouter SDK
  new MistralProvider(),            // Hostname detection
  new DeepSeekProvider(),           // DeepSeek (OpenAI-compatible, api.deepseek.com)
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
