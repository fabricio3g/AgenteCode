import crypto from 'node:crypto';
import { loadConfigFromDisk } from './config.ts';
import { resolveProvider } from './providers/registry.ts';
import { normalizeBaseUrl } from './providers/helpers.ts';
import { safeParseJson } from './providers/helpers.ts';

const activeStreams = new Map();

const _configCache = { data: null, ts: 0 };
const CONFIG_CACHE_TTL = 30_000;

function getCachedConfig() {
  const now = Date.now();
  if (_configCache.data && now - _configCache.ts < CONFIG_CACHE_TTL) {
    return _configCache.data;
  }
  _configCache.data = loadConfigFromDisk();
  _configCache.ts = now;
  return _configCache.data;
}

export function resolveApiKeyFromConfig(cfg, apiKey, baseUrl, providerName) {
  if (apiKey) return apiKey;
  const providers = cfg?.llm?.providers || {};
  const defaultProvider = cfg?.llm?.provider;

  if (providerName && providers[providerName]?.api_key) {
    return providers[providerName].api_key;
  }
  const normalizedBase = normalizeBaseUrl(baseUrl);
  for (const provider of Object.values(providers)) {
    if (normalizeBaseUrl(provider.base_url) === normalizedBase && provider.api_key) {
      return provider.api_key;
    }
  }
  if (!providerName && defaultProvider && providers[defaultProvider]?.api_key) {
    return providers[defaultProvider].api_key;
  }
  return '';
}

export function resolveApiKey(apiKey, baseUrl, providerName) {
  return resolveApiKeyFromConfig(getCachedConfig(), apiKey, baseUrl, providerName);
}

function mergeToolCallText(currentValue, nextValue, { append = false } = {}) {
  const current = String(currentValue || '');
  const next = String(nextValue || '');
  if (!next) return current;
  if (!current) return next;
  if (current === next) return current;
  if (next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;
  if (!append) return next.length > current.length ? next : current;
  if (current.endsWith(next)) return current;
  return current + next;
}

export function accumulateToolCallDelta(toolCallAccumulator, delta, { appendArguments = true } = {}) {
  if (!delta) return;
  const index = Number.isFinite(delta.index) ? delta.index : 0;
  const existing = toolCallAccumulator.get(index) || { id: '', name: '', arguments: '' };
  existing.id = mergeToolCallText(existing.id, delta.id, { append: false });
  existing.name = mergeToolCallText(existing.name, delta.name, { append: false });
  existing.arguments = mergeToolCallText(existing.arguments, delta.arguments, { append: appendArguments });
  toolCallAccumulator.set(index, existing);
}

export function finalizeToolCalls(toolCallAccumulator) {
  if (!toolCallAccumulator?.size) return undefined;
  return Array.from(toolCallAccumulator.values()).map(tc => ({
    id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
    name: tc.name,
    arguments: safeParseJson(tc.arguments) || tc.arguments
  })).filter(tc => tc.name);
}

// ── Public API ──

export async function completeChatRequest({ baseUrl, apiKey, providerName, body }) {
  const provider = resolveProvider(providerName, baseUrl);
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  if (!realKey && provider.name !== 'local') {
    const cfg = getCachedConfig();
    const defaultProvider = cfg?.llm?.provider || 'none';
    const availableProviders = Object.keys(cfg?.llm?.providers || {}).join(', ') || 'none';
    throw new Error(`No API key configured for "${providerName || defaultProvider}". Available providers: ${availableProviders}. Please add your API key in Settings > Model Hub > API Providers.`);
  }

  const params = Object.fromEntries(
    Object.entries({
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      tool_choice: body.tool_choice,
      response_format: body.response_format,
      ...body.extra_params
    }).filter(([, v]) => v !== undefined)
  );

  return provider.completeChat({
    apiKey: realKey,
    baseUrl,
    model: body.model,
    messages: body.messages,
    tools: body.tools,
    ...params
  });
}

export async function startChatStream({ baseUrl, apiKey, providerName, body }, win) {
  const provider = resolveProvider(providerName, baseUrl);
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  if (!realKey && provider.name !== 'local') {
    const cfg = getCachedConfig();
    const defaultProvider = cfg?.llm?.provider || 'none';
    const availableProviders = Object.keys(cfg?.llm?.providers || {}).join(', ') || 'none';
    const errorMsg = `No API key configured for "${providerName || defaultProvider}". Available providers: ${availableProviders}. Please add your API key in Settings > Model Hub > API Providers.`;

    const streamId = crypto.randomUUID();
    const emit = (payload) => {
      try {
        win?.webContents?.send('chat-stream-event', { streamId, ...payload });
      } catch {
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
    }
  };

  (async () => {
    try {
      const streamParams = {
        apiKey: realKey,
        baseUrl,
        model: body.model,
        messages: body.messages,
        tools: body.tools,
        ...Object.fromEntries(
          Object.entries({
            max_tokens: body.max_tokens,
            temperature: body.temperature,
            top_p: body.top_p,
            ...body.extra_params
          }).filter(([, v]) => v !== undefined)
        )
      };

      const toolCallAccumulator = new Map();
      let finalUsage = null;

      for await (const delta of provider.streamChat(streamParams)) {
        if (abortController.signal.aborted) {
          break;
        }

        if (delta.usage) finalUsage = delta.usage;

        emit({ type: 'delta', content: delta.content, reasoning: delta.reasoning });

        if (delta.toolCallDeltas) {
          for (const tc of delta.toolCallDeltas) {
            accumulateToolCallDelta(toolCallAccumulator, tc, { appendArguments: true });
          }
        }

        if (delta.toolCallDelta) {
          accumulateToolCallDelta(toolCallAccumulator, delta.toolCallDelta, { appendArguments: false });
        }
      }

      if (abortController.signal.aborted) {
        emit({ type: 'cancelled' });
        return;
      }

      const finalToolCalls = finalizeToolCalls(toolCallAccumulator);
      emit({ type: 'done', toolCalls: finalToolCalls, usage: finalUsage });
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
