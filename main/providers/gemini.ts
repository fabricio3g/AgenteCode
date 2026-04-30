import { GoogleGenerativeAI } from '@google/generative-ai';
import { BaseProvider } from './base.ts';
import { numberOrNull, safeParseJson } from './helpers.ts';

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

  async *streamChat({ apiKey, model, messages, max_tokens, temperature, top_p, tools }) {
    const client = this.createClient(apiKey);
    const geminiModel = this._getModel(client, model);
    const { systemInstruction, contents } = this._buildContents(messages);
    const geminiTools = this._convertTools(tools);

    const generationConfig = {};
    if (max_tokens) generationConfig.maxOutputTokens = max_tokens;
    if (temperature != null) generationConfig.temperature = temperature;
    if (top_p != null) generationConfig.topP = top_p;

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

  async completeChat({ apiKey, model, messages, max_tokens, temperature, top_p, tools }) {
    const client = this.createClient(apiKey);
    const geminiModel = this._getModel(client, model);
    const { systemInstruction, contents } = this._buildContents(messages);
    const geminiTools = this._convertTools(tools);

    const generationConfig = {};
    if (max_tokens) generationConfig.maxOutputTokens = max_tokens;
    if (temperature != null) generationConfig.temperature = temperature;
    if (top_p != null) generationConfig.topP = top_p;

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

  async fetchModels(apiKey, _baseUrl) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey || ''}`;
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

  async fetchModelMetadata(apiKey, _baseUrl, modelId) {
    const normalizedModelId = String(modelId || '').startsWith('models/') ? String(modelId) : `models/${modelId}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/${normalizedModelId}?key=${apiKey || ''}`;

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
