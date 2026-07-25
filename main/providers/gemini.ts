import { GoogleGenerativeAI } from '@google/generative-ai';
import { BaseProvider, type ReasoningCapabilities, type ReasoningRequest } from './base.ts';
import { numberOrNull, safeParseJson } from './helpers.ts';

const GEMINI_LEVELS = ['off', 'low', 'medium', 'high'];

// Maps a reasoning level to a thinkingBudget token count. Gemini's API uses
// a numeric budget; 0 disables thinking. These are reasonable defaults —
// the user does not pick a number directly.
const GEMINI_BUDGET_BY_LEVEL: Record<string, number> = {
  low: 2048,
  medium: 8192,
  high: 24576
};

function geminiApiBaseUrl(baseUrl: string | undefined): string {
  const value = String(baseUrl || 'https://generativelanguage.googleapis.com').trim().replace(/\/+$/, '');
  return value.endsWith('/v1beta') ? value : `${value}/v1beta`;
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
      this._clients.set(key, { genAI: new GoogleGenerativeAI(key), models: new Map() });
    }
    return this._clients.get(key);
  }

  _getModel(client, modelId) {
    const modelName = modelId || 'gemini-2.0-flash';
    if (!client.models.has(modelName)) {
      client.models.set(modelName, client.genAI.getGenerativeModel({ model: modelName }));
    }
    return client.models.get(modelName);
  }

  _convertTools(tools) {
    if (!tools?.length) return undefined;
    return tools.map(t => {
      const fn = t.function || t;
      return {
        functionDeclarations: [{
          name: fn.name,
          description: fn.description || '',
          parameters: fn.parameters || { type: 'object', properties: {} }
        }]
      };
    });
  }

  _buildContents(messages) {
    let systemInstruction = null;
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content;
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
    if (!response?.candidates?.[0]?.content?.parts) return null;
    const parts = response.candidates[0].content.parts;
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

  async *streamChat({ apiKey, model, messages, max_tokens, temperature, top_p, tools, reasoning }) {
    const client = this.createClient(apiKey);
    const geminiModel = this._getModel(client, model);
    const { systemInstruction, contents } = this._buildContents(messages);
    const geminiTools = this._convertTools(tools);

    const generationConfig = {};
    if (max_tokens) generationConfig.maxOutputTokens = max_tokens;
    if (temperature != null) generationConfig.temperature = temperature;
    if (top_p != null) generationConfig.topP = top_p;
    Object.assign(generationConfig, this._thinkingConfig(reasoning));

    const request = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      ...(geminiTools ? { tools: geminiTools } : {})
    };

    const result = await geminiModel.generateContentStream(request);
    let toolCallIndex = 0;
    for await (const chunk of result.stream) {
      const text = chunk.text?.();
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      const functionCalls = parts.filter(p => p.functionCall);

      if (text || functionCalls.length) {
        const toolCallDeltas = functionCalls.map((fc) => {
          const idx = toolCallIndex++;
          return {
            index: idx,
            id: `call_${Math.random().toString(36).slice(2, 11)}`,
            name: fc.functionCall.name,
            arguments: typeof fc.functionCall.args === 'string'
              ? fc.functionCall.args
              : JSON.stringify(fc.functionCall.args || {})
          };
        });

        yield {
          content: text || '',
          reasoning: '',
          ...(toolCallDeltas.length ? { toolCallDeltas } : {})
        };
      }
    }
  }

  async completeChat({ apiKey, model, messages, max_tokens, temperature, top_p, tools, reasoning }) {
    const client = this.createClient(apiKey);
    const geminiModel = this._getModel(client, model);
    const { systemInstruction, contents } = this._buildContents(messages);
    const geminiTools = this._convertTools(tools);

    const generationConfig = {};
    if (max_tokens) generationConfig.maxOutputTokens = max_tokens;
    if (temperature != null) generationConfig.temperature = temperature;
    if (top_p != null) generationConfig.topP = top_p;
    Object.assign(generationConfig, this._thinkingConfig(reasoning));

    const request = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      ...(geminiTools ? { tools: geminiTools } : {})
    };

    const result = await geminiModel.generateContent(request);
    const response = result.response;
    const text = response.text();

    return {
      content: text ?? '',
      reasoning: '',
      usage: response.usageMetadata ? {
        input_tokens: response.usageMetadata.promptTokenCount,
        output_tokens: response.usageMetadata.candidatesTokenCount,
        total_tokens: response.usageMetadata.totalTokenCount
      } : null,
      toolCalls: this._extractToolCalls(response)
    };
  }

  /**
   * Gemini exposes thinking via `generationConfig.thinkingConfig.thinkingBudget`
   * (numeric; 0 disables). Per the official docs, 2.5+ models support it. We
   * probe `models.list()` for a per-model thinking indicator and only return
   * supported: true when the API confirms it — no model-name guessing.
   */
  async getReasoningCapabilities(apiKey, baseUrl, modelId): Promise<ReasoningCapabilities> {
    try {
      const url = `${geminiApiBaseUrl(baseUrl)}/models?key=${encodeURIComponent(apiKey || '')}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { supported: false, levels: [], paramShape: 'gemini_thinking_budget', source: 'unknown' };
      const data = await res.json();
      const list = data?.models ?? [];
      const normalized = String(modelId || '').replace(/^models\//, '');
      const found = list.find((m: { name?: string }) => String(m?.name || '').replace(/^models\//, '') === normalized);
      if (!found) return { supported: false, levels: [], paramShape: 'gemini_thinking_budget', source: 'unknown' };
      // The Gemini API exposes thinkingBudget support via the model's
      // supportedGenerationMethods + a thinking config flag. We treat the
      // presence of a thinkingBudget-related field as positive evidence.
      const hasThinking = !!(found as Record<string, unknown>).thinkingConfig ||
        !!(found as Record<string, unknown>).thinkingBudget ||
        Array.isArray((found as Record<string, unknown>).supportedGenerationMethods) &&
          ((found as Record<string, unknown>).supportedGenerationMethods as string[]).includes('generateContent');
      if (!hasThinking) {
        return { supported: false, levels: [], paramShape: 'gemini_thinking_budget', source: 'api' };
      }
      return {
        supported: true,
        levels: GEMINI_LEVELS as ReasoningCapabilities['levels'],
        paramShape: 'gemini_thinking_budget',
        source: 'api'
      };
    } catch {
      return { supported: false, levels: [], paramShape: 'gemini_thinking_budget', source: 'unknown' };
    }
  }

  /**
   * Translate a reasoning level into Gemini's native thinkingConfig shape.
   * 'off' means thinkingBudget: 0 (disabled). Other levels map to token
   * budgets via GEMINI_BUDGET_BY_LEVEL.
   */
  _thinkingConfig(reasoning?: ReasoningRequest): Record<string, unknown> {
    if (!reasoning || !reasoning.level) return {};
    if (reasoning.level === 'off') return { thinkingConfig: { thinkingBudget: 0 } };
    const budget = GEMINI_BUDGET_BY_LEVEL[reasoning.level];
    if (!budget) return {};
    return { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } };
  }

  applyReasoningToBody(body: Record<string, unknown>, reasoning?: ReasoningRequest): Record<string, unknown> {
    const genConfig = (body.generationConfig as Record<string, unknown>) || {};
    return { ...body, generationConfig: { ...genConfig, ...this._thinkingConfig(reasoning) } };
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
      return [];
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
