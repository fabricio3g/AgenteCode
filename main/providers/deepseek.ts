import OpenAI from 'openai';
import { BaseProvider, type ReasoningCapabilities, type ReasoningRequest } from './base.ts';
import { OpenAIProvider } from './openai.ts';

/**
 * DeepSeek API (OpenAI-compatible) — see https://api-docs.deepseek.com/guides/thinking_mode
 *
 * Thinking:
 *   thinking: { type: 'enabled' | 'disabled' }  (default enabled on server)
 * Effort (OpenAI format):
 *   reasoning_effort: 'high' | 'max'
 *   (low/medium map to high; xhigh maps to max — per official docs)
 *
 * Models: deepseek-v4-flash, deepseek-v4-pro
 *   deepseek-chat / deepseek-reasoner deprecate 2026-07-24 (aliases for flash modes)
 *
 * Tool + thinking: assistant turns with tool_calls MUST echo reasoning_content
 * back on subsequent requests (handled in agent.ts).
 */

/** UI / API levels we expose for DeepSeek thinking. */
const DEEPSEEK_LEVELS = ['off', 'high', 'max'] as const;

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

  async getReasoningCapabilities(): Promise<ReasoningCapabilities> {
    return {
      supported: true,
      levels: [...DEEPSEEK_LEVELS] as ReasoningCapabilities['levels'],
      paramShape: 'openai_reasoning_effort',
      source: 'sdk'
    };
  }

  /**
   * Map UI level → DeepSeek body.
   * - off → thinking disabled
   * - high / max → thinking enabled + reasoning_effort
   * - low / medium → high (compat)
   * - xhigh → max (compat)
   */
  _reasoningBody(reasoning?: ReasoningRequest): Record<string, unknown> {
    if (!reasoning || !reasoning.level || reasoning.level === 'off' || reasoning.level === 'disabled') {
      return { thinking: { type: 'disabled' } };
    }

    let effort: 'high' | 'max' = 'high';
    const level = reasoning.level;
    if (level === 'max' || level === 'xhigh') {
      effort = 'max';
    } else if (level === 'high' || level === 'low' || level === 'medium' || level === 'enabled' || level === 'on') {
      effort = 'high';
    } else if (level === 'minimal' || level === 'none') {
      return { thinking: { type: 'disabled' } };
    }

    return {
      thinking: { type: 'enabled' },
      reasoning_effort: effort
    };
  }

  applyReasoningToBody(body: Record<string, unknown>, reasoning?: ReasoningRequest): Record<string, unknown> {
    return { ...body, ...this._reasoningBody(reasoning) };
  }
}

/** Exported for unit tests */
export function mapDeepSeekReasoningBody(reasoning?: ReasoningRequest): Record<string, unknown> {
  return new DeepSeekProvider()._reasoningBody(reasoning);
}
