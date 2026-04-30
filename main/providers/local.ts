import { BaseProvider } from './base.ts';
import { normalizeBaseUrl, safeParseJson } from './helpers.ts';
import { getGgufMetadata } from '../model-manager.ts';

export class LocalProvider extends BaseProvider {
  name = 'local';
  label = 'Local (llama.cpp)';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name === 'local' || name === 'llama_cpp' || name === 'llamacpp' ||
      url.includes('127.0.0.1') || url.includes('localhost');
  }

  _resolveUrl(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return 'http://127.0.0.1:11435/v1/chat/completions';
    return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
  }

  _buildHeaders() {
    return { 'Content-Type': 'application/json' };
  }

  async *streamChat({ baseUrl, model, messages, tools, signal, ...params }) {
    const url = this._resolveUrl(baseUrl);

    const response = await fetch(url, {
      method: 'POST',
      headers: this._buildHeaders(),
      signal,
      body: JSON.stringify({
        model: model || 'local-model',
        messages,
        stream: true,
        ...(tools?.length ? { tools } : {}),
        ...params
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => 'Local request failed');
      throw new Error(detail || `HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response stream available');
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = String(line || '').trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta || {};
          const content = delta.content;
          const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
          const toolCallDeltas = delta.tool_calls;

          if (content || reasoning || toolCallDeltas) {
            yield {
              content: content != null ? String(content) : '',
              reasoning: reasoning != null ? String(reasoning) : '',
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
        } catch {
          // skip malformed lines
        }
      }
    }

    const trimmedTail = String(buffer || '').trim();
    if (trimmedTail.startsWith('data:')) {
      const payload = trimmedTail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta || {};
          const content = delta.content;
          const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
          const toolCallDeltas = delta.tool_calls;

          if (content || reasoning || toolCallDeltas) {
            yield {
              content: content != null ? String(content) : '',
              reasoning: reasoning != null ? String(reasoning) : '',
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
        } catch {
          // skip
        }
      }
    }
  }

  async completeChat({ baseUrl, model, messages, tools, signal, ...params }) {
    const url = this._resolveUrl(baseUrl);

    const response = await fetch(url, {
      method: 'POST',
      headers: this._buildHeaders(),
      signal,
      body: JSON.stringify({
        model: model || 'local-model',
        messages,
        stream: false,
        ...(tools?.length ? { tools } : {}),
        ...params
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => 'Local request failed');
      throw new Error(detail || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const choice = data?.choices?.[0] || {};
    const message = choice.message || {};
    const rawReasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;

    return {
      content: message.content || '',
      reasoning: rawReasoning ? String(rawReasoning) : '',
      usage: data?.usage || null,
      toolCalls: message.tool_calls ? message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function?.name || '',
        arguments: safeParseJson(tc.function?.arguments) || tc.function?.arguments || ''
      })) : null
    };
  }

  async fetchModels(_apiKey, baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return [];
    const url = `${normalized}/models`;
    const headers = { 'Accept': 'application/json' };
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const list = data?.data ?? data?.models ?? [];
    return list.map(m => m.id).filter(Boolean).sort();
  }

  /**
   * Detect tool support from GGUF metadata.
   * Falls back to the base probe-based approach if GGUF metadata is unavailable.
   */
  async checkToolSupport({ baseUrl, apiKey, model, modelPath, ...rest }) {
    // Try GGUF metadata first (chat_template_uses_tools is the definitive flag)
    if (modelPath) {
      try {
        const meta = await getGgufMetadata(modelPath);
        if (typeof meta?.chat_template_uses_tools === 'boolean') {
          return {
            supportsTools: meta.chat_template_uses_tools,
            source: 'gguf_metadata'
          };
        }
      } catch {
        // Fall through to probe
      }
    }

    // If no GGUF metadata path or it failed, try the llama.cpp server API probe
    return super.checkToolSupport({ baseUrl, apiKey, model, ...rest });
  }
}
