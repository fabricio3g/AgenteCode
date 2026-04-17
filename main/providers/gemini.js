import { BaseProvider } from './base.js';

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

  resolveUrl(baseUrl, apiKey, model) {
    const modelName = model || 'gemini-2.0-flash';
    const key = apiKey || '';
    const base = baseUrl || 'https://generativelanguage.googleapis.com';
    const normalized = base.replace(/\/+$/, '');
    return `${normalized}/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${key}`;
  }

  resolveNonStreamUrl(baseUrl, apiKey, model) {
    const modelName = model || 'gemini-2.0-flash';
    const key = apiKey || '';
    const base = baseUrl || 'https://generativelanguage.googleapis.com';
    const normalized = base.replace(/\/+$/, '');
    return `${normalized}/v1beta/models/${modelName}:generateContent?key=${key}`;
  }

  buildHeaders(_apiKey) {
    return { 'Content-Type': 'application/json' };
  }

  transformBody(body) {
    const openaiMessages = Array.isArray(body?.messages) ? body.messages : [];
    let systemInstruction = null;
    const contents = [];

    for (const msg of openaiMessages) {
      if (msg.role === 'system') {
        systemInstruction = { parts: [{ text: msg.content }] };
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      }
    }

    const result = {
      contents,
      generationConfig: {}
    };
    if (systemInstruction) result.systemInstruction = systemInstruction;
    if (body.max_tokens) result.generationConfig.maxOutputTokens = body.max_tokens;
    if (body.temperature != null) result.generationConfig.temperature = body.temperature;
    if (body.top_p != null) result.generationConfig.topP = body.top_p;

    return result;
  }

  parseStreamDelta(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return null;

    const payload = trimmed.slice(5).trim();
    if (!payload) return null;

    try {
      const parsed = JSON.parse(payload);
      const parts = parsed?.candidates?.[0]?.content?.parts || [];
      let content = '';
      let reasoning = '';
      for (const part of parts) {
        if (part.text) content += part.text;
        if (part.thought) reasoning += part.thought;
      }
      if (!content && !reasoning) return null;
      return { content, reasoning };
    } catch {
      return null;
    }
  }

  parseResponse(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    let content = '';
    let reasoning = '';
    for (const part of parts) {
      if (part.text) content += part.text;
      if (part.thought) reasoning += part.thought;
    }
    return {
      content,
      reasoning,
      usage: data?.usageMetadata ? {
        input_tokens: data.usageMetadata.promptTokenCount,
        output_tokens: data.usageMetadata.candidatesTokenCount,
        total_tokens: data.usageMetadata.totalTokenCount
      } : null
    };
  }

  async fetchModels(apiKey, baseUrl) {
    const base = baseUrl || 'https://generativelanguage.googleapis.com';
    const url = `${base.replace(/\/+$/, '')}/v1beta/models?key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const list = data?.models ?? [];
    return list
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name?.replace('models/', '') || m.name)
      .filter(Boolean)
      .sort();
  }

  async fetchModelMetadata(apiKey, baseUrl, modelId) {
    const base = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    const normalizedModelId = String(modelId || '').startsWith('models/') ? String(modelId) : `models/${modelId}`;
    const url = `${base}/v1beta/${normalizedModelId}?key=${apiKey || ''}`;

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

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
