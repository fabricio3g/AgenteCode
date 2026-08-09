import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { BaseProvider, type ReasoningCapabilities, type ReasoningRequest } from './base.ts';
import { numberOrNull, safeParseJson } from './helpers.ts';

const GEMINI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'] as const;

// Gemini 2.5 uses numeric thinkingBudget. 0 disables (where allowed); -1 is dynamic.
const GEMINI_BUDGET_BY_LEVEL: Record<string, number> = {
  off: 0,
  minimal: 512,
  low: 2048,
  medium: 8192,
  high: 24576
};

const GEMINI_LEVEL_ENUM: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH
};

function geminiApiBaseUrl(baseUrl: string | undefined): string {
  const value = String(baseUrl || 'https://generativelanguage.googleapis.com').trim().replace(/\/+$/, '');
  return value.endsWith('/v1beta') ? value : `${value}/v1beta`;
}

/** Gemini 3+ uses thinkingLevel; 2.5 uses thinkingBudget. */
function usesThinkingLevel(modelId?: string): boolean {
  const id = String(modelId || '').toLowerCase();
  // Gemini 3.x family (and future 4.x) prefer thinkingLevel
  return /gemini-([3-9]|[1-9]\d)/.test(id);
}

function isThinkingCapableModel(modelId?: string): boolean {
  const id = String(modelId || '').toLowerCase();
  // 2.5+ and 3+ thinking series; exclude pure embedding/image-only when obvious
  if (!id.includes('gemini')) return false;
  if (/embedding|imagen|tts|aqa/.test(id)) return false;
  return /gemini-2\.5|gemini-3|gemini-2\.0-flash-thinking|thinking/.test(id) ||
    /gemini-([3-9]|[1-9]\d)/.test(id);
}

export class GeminiProvider extends BaseProvider {
  name = 'gemini';
  label = 'Google Gemini';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name === 'gemini' || name === 'google' || name === 'googleai' ||
      url.includes('generativelanguage.googleapis.com');
  }

  createClient(apiKey, _baseUrl) {
    const key = apiKey || '';
    if (!this._clients.has(key)) {
      this._clients.set(key, new GoogleGenAI({ apiKey: key }));
    }
    return this._clients.get(key) as GoogleGenAI;
  }

  _convertTools(tools) {
    if (!tools?.length) return undefined;
    return [{
      functionDeclarations: tools.map(t => {
        const fn = t.function || t;
        return {
          name: fn.name,
          description: fn.description || '',
          parameters: fn.parameters || { type: 'object', properties: {} }
        };
      })
    }];
  }

  _buildContents(messages) {
    let systemInstruction: string | null = null;
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = typeof msg.content === 'string' ? msg.content : String(msg.content || '');
      } else {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        if (typeof msg.content === 'string') {
          contents.push({ role, parts: [{ text: msg.content }] });
        } else if (Array.isArray(msg.content)) {
          const parts = msg.content.map(part => {
            if (part.type === 'text') return { text: part.text };
            if (part.type === 'image_url') {
              return {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: String(part.image_url?.url || '').replace(/^data:image\/\w+;base64,/, '')
                }
              };
            }
            return { text: '' };
          });
          contents.push({ role, parts });
        }
      }
    }

    return { systemInstruction, contents };
  }

  _extractToolCalls(response) {
    const parts = response?.candidates?.[0]?.content?.parts;
    if (!parts?.length) return null;
    const calls = [];
    for (const part of parts) {
      if (part.functionCall) {
        calls.push({
          id: `call_${Math.random().toString(36).slice(2, 11)}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || safeParseJson(part.functionCall.args) || {}
        });
      }
    }
    return calls.length ? calls : null;
  }

  _extractTextAndThoughts(parts: Array<Record<string, unknown>> | undefined): { text: string; reasoning: string } {
    if (!parts?.length) return { text: '', reasoning: '' };
    let text = '';
    let reasoning = '';
    for (const part of parts) {
      const partText = typeof part.text === 'string' ? part.text : '';
      if (!partText) continue;
      if (part.thought === true) {
        reasoning += partText;
      } else {
        text += partText;
      }
    }
    return { text, reasoning };
  }

  _buildConfig({ max_tokens, temperature, top_p, systemInstruction, tools, reasoning, model }) {
    const config: Record<string, unknown> = {};
    if (max_tokens) config.maxOutputTokens = max_tokens;
    if (temperature != null) config.temperature = temperature;
    if (top_p != null) config.topP = top_p;
    if (systemInstruction) config.systemInstruction = systemInstruction;
    if (tools?.length) config.tools = tools;

    const thinkingConfig = this._thinkingConfig(reasoning, model);
    if (Object.keys(thinkingConfig).length) {
      config.thinkingConfig = thinkingConfig;
    }
    return config;
  }

  async *streamChat({ apiKey, model, messages, max_tokens, temperature, top_p, tools, reasoning }) {
    const client = this.createClient(apiKey);
    const { systemInstruction, contents } = this._buildContents(messages);
    const geminiTools = this._convertTools(tools);
    const config = this._buildConfig({
      max_tokens, temperature, top_p, systemInstruction, tools: geminiTools, reasoning, model
    });

    const stream = await client.models.generateContentStream({
      model: model || 'gemini-2.0-flash',
      contents,
      config
    });

    let toolCallIndex = 0;
    for await (const chunk of stream) {
      const parts = (chunk.candidates?.[0]?.content?.parts || []) as Array<Record<string, unknown>>;
      const { text, reasoning: thoughtText } = this._extractTextAndThoughts(parts);
      const functionCalls = parts.filter(p => p.functionCall);

      if (text || thoughtText || functionCalls.length) {
        const toolCallDeltas = functionCalls.map((fc) => {
          const idx = toolCallIndex++;
          const call = fc.functionCall as { name?: string; args?: unknown };
          return {
            index: idx,
            id: `call_${Math.random().toString(36).slice(2, 11)}`,
            name: call?.name,
            arguments: typeof call?.args === 'string'
              ? call.args
              : JSON.stringify(call?.args || {})
          };
        });

        yield {
          content: text || '',
          reasoning: thoughtText || '',
          ...(toolCallDeltas.length ? { toolCallDeltas } : {})
        };
      }
    }
  }

  async completeChat({ apiKey, model, messages, max_tokens, temperature, top_p, tools, reasoning }) {
    const client = this.createClient(apiKey);
    const { systemInstruction, contents } = this._buildContents(messages);
    const geminiTools = this._convertTools(tools);
    const config = this._buildConfig({
      max_tokens, temperature, top_p, systemInstruction, tools: geminiTools, reasoning, model
    });

    const response = await client.models.generateContent({
      model: model || 'gemini-2.0-flash',
      contents,
      config
    });

    const parts = (response.candidates?.[0]?.content?.parts || []) as Array<Record<string, unknown>>;
    const { text, reasoning: thoughtText } = this._extractTextAndThoughts(parts);

    // Fallback: some SDK paths expose .text helper only for non-thought parts
    const fallbackText = !text && typeof response.text === 'string' ? response.text : text;

    return {
      content: fallbackText ?? '',
      reasoning: thoughtText || '',
      usage: response.usageMetadata ? {
        input_tokens: response.usageMetadata.promptTokenCount,
        output_tokens: response.usageMetadata.candidatesTokenCount,
        total_tokens: response.usageMetadata.totalTokenCount
      } : null,
      toolCalls: this._extractToolCalls(response)
    };
  }

  /**
   * Thinking is supported on Gemini 2.5 / 3 series. Prefer model-id evidence
   * from the official thinking matrix rather than inventing per-model fields
   * that the list API does not expose.
   */
  async getReasoningCapabilities(_apiKey, _baseUrl, modelId): Promise<ReasoningCapabilities> {
    if (!isThinkingCapableModel(modelId)) {
      return { supported: false, levels: [], paramShape: 'gemini_thinking_budget', source: 'sdk' };
    }
    return {
      supported: true,
      levels: [...GEMINI_LEVELS] as ReasoningCapabilities['levels'],
      paramShape: 'gemini_thinking_budget',
      source: 'sdk'
    };
  }

  /**
   * Gemini 3+: thinkingLevel (+ includeThoughts).
   * Gemini 2.5: thinkingBudget (+ includeThoughts).
   */
  _thinkingConfig(reasoning?: ReasoningRequest, modelId?: string): Record<string, unknown> {
    if (!reasoning || !reasoning.level) return {};

    const level = reasoning.level;
    const preferLevel = usesThinkingLevel(modelId);

    if (preferLevel) {
      if (level === 'off' || level === 'disabled' || level === 'none') {
        // Gemini 3 Flash: full off not always supported — use MINIMAL
        return { thinkingLevel: ThinkingLevel.MINIMAL, includeThoughts: false };
      }
      const enumLevel = GEMINI_LEVEL_ENUM[level] || GEMINI_LEVEL_ENUM.medium;
      return { thinkingLevel: enumLevel, includeThoughts: true };
    }

    // Gemini 2.5 budget path
    if (level === 'off' || level === 'disabled' || level === 'none') {
      return { thinkingBudget: 0, includeThoughts: false };
    }
    const budget = GEMINI_BUDGET_BY_LEVEL[level];
    if (budget == null) return {};
    return { thinkingBudget: budget, includeThoughts: true };
  }

  applyReasoningToBody(body: Record<string, unknown>, reasoning?: ReasoningRequest): Record<string, unknown> {
    const modelId = typeof body.model === 'string' ? body.model : undefined;
    const genConfig = (body.generationConfig as Record<string, unknown>) ||
      (body.config as Record<string, unknown>) ||
      {};
    const thinkingConfig = this._thinkingConfig(reasoning, modelId);
    if (!Object.keys(thinkingConfig).length) return body;
    return {
      ...body,
      generationConfig: { ...genConfig, thinkingConfig },
      config: { ...genConfig, thinkingConfig }
    };
  }

  async fetchModels(apiKey, baseUrl) {
    try {
      const url = `${geminiApiBaseUrl(baseUrl)}/models?key=${encodeURIComponent(apiKey || '')}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = data?.models ?? [];
      return list
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name?.replace('models/', '') || m.name)
        .filter(Boolean)
        .sort();
    } catch {
      // Fallback via SDK if REST fails
      try {
        const client = this.createClient(apiKey);
        const pager = await client.models.list();
        const ids: string[] = [];
        for await (const m of pager) {
          const name = String(m.name || '').replace(/^models\//, '');
          if (name) ids.push(name);
        }
        return ids.sort();
      } catch {
        return [];
      }
    }
  }

  async fetchModelMetadata(apiKey, baseUrl, modelId) {
    const normalizedModelId = String(modelId || '').startsWith('models/') ? String(modelId) : `models/${modelId}`;
    const url = `${geminiApiBaseUrl(baseUrl)}/${normalizedModelId}?key=${encodeURIComponent(apiKey || '')}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const data = await res.json();
      const contextWindow = numberOrNull(data?.inputTokenLimit ?? data?.input_token_limit);
      if (!contextWindow) return null;
      const maxCompletionTokens = numberOrNull(data?.outputTokenLimit ?? data?.output_token_limit);
      return {
        context_window: contextWindow,
        ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {})
      };
    } catch {
      return null;
    }
  }
}

/** Exported for unit tests */
export function mapGeminiThinkingConfig(
  reasoning?: ReasoningRequest,
  modelId?: string
): Record<string, unknown> {
  return new GeminiProvider()._thinkingConfig(reasoning, modelId);
}
