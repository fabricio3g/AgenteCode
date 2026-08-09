import Groq from 'groq-sdk';
import { BaseProvider, type ReasoningCapabilities, type ReasoningRequest } from './base.ts';
import { normalizeBaseUrl, numberOrNull, safeParseJson } from './helpers.ts';

/** GPT-OSS models on Groq: low | medium | high */
const GROQ_GPT_OSS_LEVELS = ['off', 'low', 'medium', 'high'] as const;
/** Qwen 3.x reasoning models: none | default */
const GROQ_QWEN_LEVELS = ['off', 'none', 'default'] as const;

/**
 * groq-sdk request paths already include `/openai/v1/...`.
 * Base URL must be the host root (https://api.groq.com), not .../openai/v1,
 * or requests become /openai/v1/openai/v1/chat/completions (404).
 */
export function normalizeGroqBaseUrl(baseUrl?: string): string {
  const raw = normalizeBaseUrl(baseUrl) || 'https://api.groq.com';
  const stripped = raw.replace(/\/openai\/v1$/i, '');
  return stripped || 'https://api.groq.com';
}

export class GroqProvider extends BaseProvider {
  name = 'groq';
  label = 'Groq';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name === 'groq' || url.includes('api.groq.com');
  }

  createClient(apiKey, baseUrl) {
    const baseURL = normalizeGroqBaseUrl(baseUrl);
    const clientKey = `${apiKey || ''}::${baseURL}`;
    if (!this._clients.has(clientKey)) {
      this._clients.set(clientKey, new Groq({
        apiKey,
        baseURL
      }));
    }
    return this._clients.get(clientKey);
  }

  async *streamChat({ apiKey, baseUrl, model, messages, tools, reasoning, signal, ...params }) {
    const client = this.createClient(apiKey, baseUrl);
    const stream = await client.chat.completions.create({
      model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...this._reasoningBody(reasoning, model),
      ...params,
      stream: true
    }, { signal });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta || {};
      const content = delta.content;
      const reasoningText = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
      const toolCallDeltas = delta.tool_calls;

      if (content || reasoningText || toolCallDeltas) {
        yield {
          content: content ?? '',
          reasoning: reasoningText ?? '',
          ...(toolCallDeltas ? {
            toolCallDeltas: toolCallDeltas.map(tc => ({
              index: tc.index ?? 0,
              id: tc.id ?? undefined,
              name: tc.function?.name ?? undefined,
              arguments: tc.function?.arguments ?? undefined
            }))
          } : {})
        };
      }
    }
  }

  async completeChat({ apiKey, baseUrl, model, messages, tools, reasoning, tool_choice, signal, ...params }) {
    const client = this.createClient(apiKey, baseUrl);
    const response = await client.chat.completions.create({
      model,
      messages,
      ...(tools?.length ? { tools, tool_choice: tool_choice || 'auto' } : {}),
      ...this._reasoningBody(reasoning, model),
      ...params,
      stream: false
    }, { signal });

    const choice = response?.choices?.[0] || {};
    const message = choice.message || {};
    const rawReasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;

    return {
      content: message.content || '',
      reasoning: rawReasoning ? String(rawReasoning) : '',
      usage: response?.usage ? {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens
      } : null,
      toolCalls: message.tool_calls ? message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function?.name || '',
        arguments: safeParseJson(tc.function?.arguments) || tc.function?.arguments || ''
      })) : null
    };
  }

  /**
   * Groq reasoning is model-family specific (see console.groq.com/docs/reasoning).
   * GPT-OSS: reasoning_effort low|medium|high
   * Qwen 3.6: reasoning_effort none|default
   */
  async getReasoningCapabilities(_apiKey, _baseUrl, modelId): Promise<ReasoningCapabilities> {
    const family = groqReasoningFamily(modelId);
    if (family === 'gpt-oss') {
      return {
        supported: true,
        levels: [...GROQ_GPT_OSS_LEVELS] as ReasoningCapabilities['levels'],
        paramShape: 'openai_reasoning_effort',
        source: 'sdk'
      };
    }
    if (family === 'qwen') {
      return {
        supported: true,
        levels: [...GROQ_QWEN_LEVELS] as ReasoningCapabilities['levels'],
        paramShape: 'openai_reasoning_effort',
        source: 'sdk'
      };
    }
    return { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'sdk' };
  }

  /**
   * Build Groq reasoning request fields.
   * Prefer include_reasoning so UI can surface chain-of-thought when present.
   */
  _reasoningBody(reasoning?: ReasoningRequest, modelId?: string): Record<string, unknown> {
    if (!reasoning || !reasoning.level || reasoning.level === 'off') return {};

    const family = groqReasoningFamily(modelId);
    const level = reasoning.level;

    if (family === 'gpt-oss') {
      if (level === 'low' || level === 'medium' || level === 'high') {
        return { reasoning_effort: level, include_reasoning: true };
      }
      return {};
    }

    if (family === 'qwen') {
      if (level === 'none' || level === 'default') {
        return { reasoning_effort: level, include_reasoning: true };
      }
      // Compat: map common UI levels
      if (level === 'disabled' || level === 'minimal') {
        return { reasoning_effort: 'none', include_reasoning: true };
      }
      if (level === 'low' || level === 'medium' || level === 'high' || level === 'on' || level === 'enabled') {
        return { reasoning_effort: 'default', include_reasoning: true };
      }
      return {};
    }

    return {};
  }

  applyReasoningToBody(body: Record<string, unknown>, reasoning?: ReasoningRequest): Record<string, unknown> {
    const modelId = typeof body.model === 'string' ? body.model : undefined;
    return { ...body, ...this._reasoningBody(reasoning, modelId) };
  }

  async fetchModels(apiKey, baseUrl) {
    const client = this.createClient(apiKey, baseUrl);
    try {
      const response = await client.models.list();
      const list = response?.data ?? [];
      return list.map(m => m.id).filter(Boolean).sort();
    } catch {
      return [];
    }
  }

  async fetchModelMetadata(apiKey, baseUrl, modelId) {
    const client = this.createClient(apiKey, baseUrl);

    const parseMetadata = (record) => {
      if (!record || typeof record !== 'object') return null;
      const contextWindow = numberOrNull(
        record.context_window ?? record.context_length ?? record.max_context_length
      );
      if (!contextWindow) return null;
      const maxCompletionTokens = numberOrNull(record.max_completion_tokens ?? record.max_output_tokens);
      return {
        context_window: contextWindow,
        ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {})
      };
    };

    try {
      const detail = await client.models.retrieve(modelId);
      const parsed = parseMetadata(detail);
      if (parsed) return parsed;
    } catch {
      // fall through
    }

    try {
      const response = await client.models.list();
      const list = response?.data ?? [];
      const found = list.find(entry => String(entry?.id || '') === String(modelId));
      return parseMetadata(found || null);
    } catch {
      return null;
    }
  }
}

function groqReasoningFamily(modelId?: string): 'gpt-oss' | 'qwen' | null {
  const id = String(modelId || '').toLowerCase();
  if (!id) return null;
  if (id.includes('gpt-oss')) return 'gpt-oss';
  if (id.includes('qwen')) return 'qwen';
  return null;
}

/** Exported for unit tests */
export function mapGroqReasoningBody(
  reasoning?: ReasoningRequest,
  modelId?: string
): Record<string, unknown> {
  return new GroqProvider()._reasoningBody(reasoning, modelId);
}
