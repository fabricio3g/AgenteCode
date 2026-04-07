import crypto from 'node:crypto';
import { loadConfigFromDisk } from './config.js';
import { resolveProvider } from './providers/registry.js';

const activeStreams = new Map();

// ── Helpers ──

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

// Resolve the real API key: use the provided key if present, otherwise look it up
// from the on-disk config by providerName first, then by matching base_url.
export function resolveApiKey(apiKey, baseUrl, providerName) {
  if (apiKey) return apiKey;
  const cfg = loadConfigFromDisk();
  const providers = cfg?.llm?.providers || {};
  const defaultProvider = cfg?.llm?.provider;

  if (providerName && providers[providerName]?.api_key) {
    return providers[providerName].api_key;
  }
  if (providerName && defaultProvider && defaultProvider !== providerName && providers[defaultProvider]?.api_key) {
    console.log(`[chat-ipc] Provider "${providerName}" has no key, using default provider "${defaultProvider}" key`);
    return providers[defaultProvider].api_key;
  }
  if (!providerName && defaultProvider && providers[defaultProvider]?.api_key) {
    return providers[defaultProvider].api_key;
  }
  const normalizedBase = normalizeBaseUrl(baseUrl);
  for (const [name, provider] of Object.entries(providers)) {
    if (normalizeBaseUrl(provider.base_url) === normalizedBase && provider.api_key) {
      console.log(`[chat-ipc] API key found by URL match for provider "${name}"`);
      return provider.api_key;
    }
  }
  console.log(`[chat-ipc] No API key found. Requested: "${providerName}", Default: "${defaultProvider}", BaseURL: "${baseUrl}"`);
  return '';
}

// ── Anthropic SSE stateful parsing helper ──

function createAnthropicStreamParser(emit) {
  let pendingEventType = null;

  return {
    processLine(line) {
      const provider = resolveProvider('anthropic', 'https://api.anthropic.com');
      const parsed = provider.parseStreamDelta(line);
      if (!parsed) return;

      if (parsed._eventType) {
        pendingEventType = parsed._eventType;
        return;
      }

      if (parsed._data) {
        const data = parsed._data;
        const evtType = pendingEventType;
        pendingEventType = null;

        if (evtType === 'content_block_delta') {
          const delta = data?.delta || {};
          const content = delta?.text || '';
          const reasoning = delta?.thinking || '';
          if (content || reasoning) {
            emit({ type: 'delta', content, reasoning });
          }
        }
        // message_delta, message_stop, message_start, content_block_start — nothing to stream
      }
    }
  };
}

// ── Public API ──

export async function completeChatRequest({ baseUrl, apiKey, providerName, body }) {
  const provider = resolveProvider(providerName, baseUrl);
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  if (!realKey) {
    const cfg = loadConfigFromDisk();
    const defaultProvider = cfg?.llm?.provider || 'none';
    const availableProviders = Object.keys(cfg?.llm?.providers || {}).join(', ') || 'none';
    throw new Error(`No API key configured for "${providerName || defaultProvider}". Available providers: ${availableProviders}. Please add your API key in Settings > Model Hub > API Providers.`);
  }

  // Gemini uses a different URL pattern
  let url;
  if (provider.name === 'gemini') {
    url = provider.resolveNonStreamUrl(baseUrl, realKey, body.model);
  } else {
    url = provider.resolveUrl(baseUrl);
  }

  const headers = provider.name === 'gemini' ? provider.buildHeaders(realKey) : provider.buildHeaders(realKey);
  const requestBody = provider.transformBody({ ...body, stream: false });

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => 'Request failed');
    throw new Error(detail || `HTTP ${response.status}`);
  }

  return response.json();
}

export async function startChatStream({ baseUrl, apiKey, providerName, body }, win) {
  console.log('[chat-ipc] startChatStream received:', {
    baseUrl,
    hasApiKey: !!apiKey,
    providerName,
    model: body?.model
  });
  const provider = resolveProvider(providerName, baseUrl);
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  if (!realKey) {
    const cfg = loadConfigFromDisk();
    const defaultProvider = cfg?.llm?.provider || 'none';
    const availableProviders = Object.keys(cfg?.llm?.providers || {}).join(', ') || 'none';
    const errorMsg = `No API key configured for "${providerName || defaultProvider}". Available providers: ${availableProviders}. Please add your API key in Settings > Model Hub > API Providers.`;

    const streamId = crypto.randomUUID();
    const emit = (payload) => {
      try {
        win?.webContents?.send('chat-stream-event', { streamId, ...payload });
      } catch {
        // Ignore renderer event delivery errors
      }
    };
    setTimeout(() => {
      emit({ type: 'error', error: errorMsg });
    }, 0);
    return { streamId };
  }
  const streamId = crypto.randomUUID();
  const abortController = new AbortController();
  activeStreams.set(streamId, abortController);

  // Safety timeout: abort and clean up stale streams after 10 minutes
  const streamTimeout = setTimeout(() => {
    if (activeStreams.has(streamId)) {
      abortController.abort();
      activeStreams.delete(streamId);
    }
  }, 10 * 60 * 1000);

  const emit = (payload) => {
    try {
      win?.webContents?.send('chat-stream-event', { streamId, ...payload });
    } catch {
      // Ignore renderer event delivery errors
    }
  };

  (async () => {
    try {
      // Gemini uses a different URL pattern that includes the model name and API key
      let url;
      if (provider.name === 'gemini') {
        url = provider.resolveUrl(baseUrl, realKey, body.model);
      } else {
        url = provider.resolveUrl(baseUrl);
      }

      const headers = provider.buildHeaders(realKey);
      const requestBody = provider.transformBody({ ...body, stream: true });

      const response = await fetch(url, {
        method: 'POST',
        headers,
        signal: abortController.signal,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => 'Request failed');
        throw new Error(detail || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream available');

      const decoder = new TextDecoder();
      let buffer = '';

      // Anthropic uses a stateful SSE parser (event type + data on separate lines)
      if (provider.name === 'anthropic') {
        const parser = createAnthropicStreamParser(emit);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          // Prevent unbounded buffer growth from oversized chunks
          if (buffer.length > 1_000_000) {
            parser.processLine(buffer);
            buffer = '';
          }

          for (const line of lines) {
            parser.processLine(line);
          }
        }
      } else {
        // OpenAI-compatible SSE format (works for OpenAI, Groq, Mistral, local, etc.)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          // Prevent unbounded buffer growth from oversized chunks
          if (buffer.length > 1_000_000) {
            const delta = provider.parseStreamDelta(buffer);
            if (delta && !delta._eventType && !delta._data) emit({ type: 'delta', content: delta.content, reasoning: delta.reasoning });
            buffer = '';
          }

          for (const line of lines) {
            const delta = provider.parseStreamDelta(line);
            if (!delta || delta._eventType || delta._data) continue;
            emit({ type: 'delta', content: delta.content, reasoning: delta.reasoning });
          }
        }

        const tail = provider.parseStreamDelta(buffer);
        if (tail && !tail._eventType && !tail._data) emit({ type: 'delta', content: tail.content, reasoning: tail.reasoning });
      }

      emit({ type: 'done' });
    } catch (error) {
      if (abortController.signal.aborted) {
        emit({ type: 'cancelled' });
      } else {
        emit({ type: 'error', error: String(error?.message || error || 'Chat stream failed') });
      }
    } finally {
      clearTimeout(streamTimeout);
      activeStreams.delete(streamId);
    }
  })();

  return { streamId };
}

export async function cancelChatStream({ streamId }) {
  const key = String(streamId || '');
  const controller = activeStreams.get(key);
  if (!controller) return { cancelled: false };
  controller.abort();
  activeStreams.delete(key);
  return { cancelled: true };
}
