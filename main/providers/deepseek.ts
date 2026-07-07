import OpenAI from 'openai';
import { BaseProvider, type ReasoningCapabilities, type ReasoningRequest } from './base.ts';
import { OpenAIProvider } from './openai.ts';

// DeepSeek is OpenAI-compatible. Per DeepSeek's API docs, the reasoning_effort
// parameter (low/medium/high) and the thinking:{type:'enabled'} flag are
// accepted on their reasoning-capable models. We declare that here, inside the
// provider that owns this API — no model-name guessing in shared code.

const DEEPSEEK_LEVELS = ['off', 'low', 'medium', 'high'];

export class DeepSeekProvider extends OpenAIProvider {
  name = 'deepseek';
  label = 'DeepSeek';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name === 'deepseek' || url.includes('api.deepseek.com');
  }

  createClient(apiKey, _baseUrl) {
    const clientKey = `${apiKey || ''}::deepseek`;
    if (!this._clients.has(clientKey)) {
      this._clients.set(clientKey, new OpenAI({
        apiKey,
        baseURL: 'https://api.deepseek.com'
      }));
    }
    return this._clients.get(clientKey);
  }

  /**
   * DeepSeek's docs state reasoning_effort + thinking are accepted on their
   * reasoning-capable models. We don't hardcode a model allowlist — if the
   * user picks a non-reasoning DeepSeek model, the server returns an error
   * which surfaces normally.
   */
  async getReasoningCapabilities(): Promise<ReasoningCapabilities> {
    return {
      supported: true,
      levels: DEEPSEEK_LEVELS as ReasoningCapabilities['levels'],
      paramShape: 'openai_reasoning_effort',
      source: 'sdk'
    };
  }

  /**
   * DeepSeek accepts the OpenAI `reasoning_effort` plus an optional
   * `thinking: { type: 'enabled' }` flag. We send both when reasoning is on.
   */
  _reasoningBody(reasoning?: ReasoningRequest): Record<string, unknown> {
    if (!reasoning || !reasoning.level || reasoning.level === 'off') return {};
    return {
      reasoning_effort: reasoning.level,
      thinking: { type: 'enabled' }
    };
  }
}

