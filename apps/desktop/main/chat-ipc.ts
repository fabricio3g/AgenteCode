import crypto from 'node:crypto';
import { getCachedConfig, resolveApiKey } from './provider-auth.ts';
import { resolveProvider } from './providers/registry.ts';
import { safeParseJson } from './providers/helpers.ts';
import { classifyError, LlmStreamError } from './providers/protocol.ts';
import { GenerationTimer } from '../shared/generation-speed.ts';
import type { AgenteClient } from './agente-client.ts';

const activeStreams = new Map();

const RUST_CORE_CLOUD_PROVIDERS = new Set([
  'openrouter',
  'deepseek',
  'opencode',
  'opencode-go',
  'minimax',
  'glm'
]);

type RustChunkNotification = {
  stream_id?: string;
  type?: 'content' | 'reasoning' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done' | 'error';
  text?: string;
  id?: string;
  name?: string;
  args_delta?: string;
  stop_reason?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  error?: string;
};

type RustStreamEntry = {
  client: AgenteClient;
  emit: (payload: Record<string, unknown>) => void;
  timer: GenerationTimer;
  timeout: ReturnType<typeof setTimeout>;
  toolCalls: Map<string, { id: string; name: string; arguments: string }>;
  cancelled: boolean;
};

const rustStreams = new Map<string, RustStreamEntry>();
const rustStreamClients = new WeakSet<AgenteClient>();

function attachRustStreamListener(client: AgenteClient): void {
  if (rustStreamClients.has(client)) return;
  rustStreamClients.add(client);
  client.onClose(() => {
    for (const [id, entry] of rustStreams) {
      if (entry.client !== client) continue;
      clearTimeout(entry.timeout);
      rustStreams.delete(id);
      if (!entry.cancelled) {
        entry.emit({ type: 'error', error: 'The Rust runtime disconnected during streaming.', errorCode: 'NETWORK' });
      }
    }
  });
  client.onNotification((method, params) => {
    if (method !== 'llm.chunk') return;
    const chunk = params as RustChunkNotification;
    const id = chunk?.stream_id;
    if (!id) return;
    const entry = rustStreams.get(id);
    if (!entry || entry.cancelled) return;

    switch (chunk.type) {
      case 'content':
        if (chunk.text) {
          entry.timer.record(performance.now());
          entry.emit({ type: 'delta', content: chunk.text, reasoning: '' });
        }
        break;
      case 'reasoning':
        if (chunk.text) {
          entry.timer.record(performance.now());
          entry.emit({ type: 'delta', content: '', reasoning: chunk.text });
        }
        break;
      case 'tool_call_start':
        if (chunk.id) {
          entry.toolCalls.set(chunk.id, { id: chunk.id, name: chunk.name || '', arguments: '' });
        }
        break;
      case 'tool_call_delta':
        if (chunk.id && chunk.args_delta) {
          entry.timer.record(performance.now());
          const existing = entry.toolCalls.get(chunk.id) ?? { id: chunk.id, name: '', arguments: '' };
          existing.arguments += chunk.args_delta;
          entry.toolCalls.set(chunk.id, existing);
        }
        break;
      case 'tool_call_end':
        break;
      case 'done': {
        clearTimeout(entry.timeout);
        rustStreams.delete(id);
        const toolCalls = entry.toolCalls.size
          ? [...entry.toolCalls.values()]
              .filter((tc) => tc.name)
              .map((tc) => ({
                id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
                name: tc.name,
                arguments: safeParseJson(tc.arguments) || tc.arguments
              }))
          : undefined;
        const outputStreamMs = entry.timer.duration();
        const u = chunk.usage;
        const usage = u
          ? {
              prompt_tokens: u.prompt_tokens ?? 0,
              completion_tokens: u.completion_tokens ?? 0,
              total_tokens: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
              ...(u.cache_read_tokens ? { prompt_tokens_details: { cached_tokens: u.cache_read_tokens } } : {}),
              ...(outputStreamMs !== undefined ? { timings: { output_stream_ms: outputStreamMs } } : {})
            }
          : null;
        entry.emit({ type: 'done', toolCalls, usage });
        break;
      }
      case 'error': {
        clearTimeout(entry.timeout);
        rustStreams.delete(id);
        const failure = classifyError(new Error(chunk.error || 'Stream error'));
        entry.emit({ type: 'error', error: failure.message, errorCode: failure.code });
        break;
      }
    }
  });
}

function toRustMessages(messages: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(messages)) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') return null;
    const msg = raw as Record<string, unknown>;
    const role = String(msg.role || '');
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) return null;
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Only convert pure text-part arrays; multimodal image_url parts keep TS path for now.
      const parts: string[] = [];
      for (const part of msg.content) {
        if (!part || typeof part !== 'object' || (part as Record<string, unknown>).type !== 'text') return null;
        parts.push(String((part as Record<string, unknown>).text || ''));
      }
      content = parts.join('\n');
    } else if (msg.content != null) {
      return null;
    }
    const converted: Record<string, unknown> = { role, content };
    if (typeof msg.tool_call_id === 'string') converted.tool_call_id = msg.tool_call_id;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      converted.tool_calls = msg.tool_calls.map((tc: Record<string, unknown>) => {
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        return {
          id: String(tc.id || ''),
          type: 'function',
          function: {
            name: String(fn.name ?? tc.name ?? ''),
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? tc.arguments ?? {})
          }
        };
      });
    }
    out.push(converted);
  }
  return out;
}

function thinkingLevelFromBody(body: Record<string, unknown>): string | undefined {
  const reasoning = body?.reasoning;
  if (typeof reasoning === 'string' && reasoning.trim()) return reasoning.trim();
  if (reasoning && typeof reasoning === 'object') {
    const level = (reasoning as Record<string, unknown>).level ?? (reasoning as Record<string, unknown>).effort;
    if (typeof level === 'string' && level.trim()) return level.trim();
    if ((reasoning as Record<string, unknown>).enabled === false) return 'off';
  }
  return undefined;
}

function canDelegateToRust(providerName: string | undefined, apiKey: string | undefined, body: Record<string, unknown> | undefined): boolean {
  const id = String(providerName || '').trim().toLowerCase();
  if (!RUST_CORE_CLOUD_PROVIDERS.has(id)) return false;
  if (apiKey) return false; // Unsaved draft key override
  if (!body || !body.model) return false;
  if (body.response_format || body.stop || body.tool_choice || body.extra_params) return false;
  return true;
}

function mergeToolCallText(currentValue, nextValue, { append = false } = {}) {
  const current = String(currentValue || '');
  const next = String(nextValue || '');
  if (!next) return current;
  if (!current) return next;
  if (append) {
    if (next.length > current.length && next.startsWith(current)) return next;
    return current + next;
  }
  if (current === next) return current;
  if (next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;
  return next.length > current.length ? next : current;
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

function authenticationError(provider: { name: string }, apiKey: string, providerName: string): string | null {
  if (apiKey || ['local', 'lmstudio', 'ollama', 'custom'].includes(provider.name)) return null;
  const cfg = getCachedConfig();
  const defaultProvider = cfg?.llm?.provider || 'none';
  const availableProviders = Object.keys(cfg?.llm?.providers || {}).join(', ') || 'none';
  return `No API key configured for "${providerName || defaultProvider}". Available providers: ${availableProviders}. Please add your API key in Settings > API.`;
}

export async function completeChatRequest({ baseUrl, apiKey, providerName, body }) {
  // Fast path: route saved core cloud providers through Rust `llm.complete`
  // (speaks Anthropic, Responses, Google, and OpenAI wire formats natively).
  if (canDelegateToRust(providerName, apiKey, body) && !body.tools?.length) {
    const rustMessages = toRustMessages(body.messages);
    if (rustMessages) {
      try {
        const { runtimeConnection } = await import('./agente/rust-engine.ts');
        const client = await runtimeConnection();
        const result = await client.request<{ text: string }>('llm.complete', {
          provider: String(providerName).trim().toLowerCase(),
          model: String(body.model),
          messages: rustMessages,
          ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {})
        });
        return {
          content: result?.text ?? '',
          reasoning: '',
          usage: null,
          toolCalls: null,
          finishReason: { kind: 'stop', raw: 'stop' }
        };
      } catch {
        // Fall back to TS provider if daemon is offline or route requires TS options.
      }
    }
  }

  const provider = resolveProvider(providerName, baseUrl);
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  const error = authenticationError(provider, realKey, providerName);
  if (error) throw new Error(error);

  const params = Object.fromEntries(
    Object.entries({
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stop: body.stop,
      tool_choice: body.tool_choice,
      response_format: body.response_format,
      ...body.extra_params
    }).filter(([, v]) => v !== undefined)
  );

  /*
   * No `signal` here. There used to be a `signal: abortController.signal`, but
   * `abortController` is local to `startChatStream` below — so this threw
   * `ReferenceError: abortController is not defined` on every single
   * `chat_complete` call, taking down the whole non-streaming path.
   *
   * It cannot be fixed by moving a controller here either: an `AbortSignal` does
   * not survive IPC structured cloning, and the renderer sends only
   * `{ baseUrl, apiKey, providerName, body }`. Cancelling a non-streaming
   * completion needs a request id plus a matching cancel channel, the way
   * `startChatStream`/`cancelChatStream` are paired.
   */
  return provider.complete({
    apiKey: realKey,
    baseUrl,
    model: body.model,
    messages: body.messages,
    tools: body.tools,
    reasoning: await thinkingFor(providerName, body),
    ...params
  });
}

/** The request's thinking level with the core's fields for it attached. */
async function thinkingFor(providerName: string, body: { model?: string; reasoning?: unknown }) {
  const { withThinkingBody } = await import('./agente/thinking.ts');
  return withThinkingBody(String(providerName || ''), body.model, body.reasoning as never);
}

export async function startChatStream({ baseUrl, apiKey, providerName, body }, win) {
  // Fast path: stream saved core cloud providers through Rust `llm.stream`
  // (native HTTP/2 + Anthropic/Responses/Google/OpenAI wire routing + instant cancel).
  if (canDelegateToRust(providerName, apiKey, body)) {
    const rustMessages = toRustMessages(body.messages);
    if (rustMessages) {
      try {
        const { runtimeConnection } = await import('./agente/rust-engine.ts');
        const client = await runtimeConnection();
        attachRustStreamListener(client);
        const streamId = crypto.randomUUID();
        const emit = (payload: Record<string, unknown>) => {
          try {
            win?.webContents?.send('chat-stream-event', { streamId, ...payload });
          } catch {
            // window may be closed
          }
        };
        const timeout = setTimeout(() => {
          const entry = rustStreams.get(streamId);
          if (!entry) return;
          entry.cancelled = true;
          rustStreams.delete(streamId);
          void client.request('llm.cancel', { stream_id: streamId }).catch(() => {});
        }, 10 * 60 * 1000);
        rustStreams.set(streamId, {
          client,
          emit,
          timer: new GenerationTimer(),
          timeout,
          toolCalls: new Map(),
          cancelled: false
        });
        try {
          await client.request('llm.stream', {
            stream_id: streamId,
            provider: String(providerName).trim().toLowerCase(),
            model: String(body.model),
            messages: rustMessages,
            ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
            ...(thinkingLevelFromBody(body) ? { thinking_level: thinkingLevelFromBody(body) } : {}),
            ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
            ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
            ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {})
          });
          return { streamId };
        } catch (rpcError) {
          clearTimeout(timeout);
          rustStreams.delete(streamId);
          throw rpcError;
        }
      } catch {
        // Fall through to TS dialect stream if daemon is offline or provider is unconfigured in Rust.
      }
    }
  }

  const provider = resolveProvider(providerName, baseUrl);
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  const errorMsg = authenticationError(provider, realKey, providerName);
  if (errorMsg) {
    const streamId = crypto.randomUUID();
    const emit = (payload) => {
      try {
        win?.webContents?.send('chat-stream-event', { streamId, ...payload });
      } catch {
      }
    };
    setTimeout(() => {
      emit({ type: 'error', error: errorMsg, errorCode: 'AUTH' });
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
        reasoning: await thinkingFor(providerName, body),
        signal: abortController.signal,
        ...Object.fromEntries(
          Object.entries({
            max_tokens: body.max_tokens,
            temperature: body.temperature,
            top_p: body.top_p,
            stop: body.stop,
            ...body.extra_params
          }).filter(([, v]) => v !== undefined)
        )
      };

      const toolCallAccumulator = new Map();
      let finalUsage = null;
      const generationTimer = new GenerationTimer();
      let providerState;

      // One normalized chunk protocol for every provider — the renderer
      // events keep their shape; usage may carry additive stream timing.
      for await (const chunk of provider.stream(streamParams)) {
        if (abortController.signal.aborted) {
          break;
        }
        if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text || chunk.type === 'tool-call-delta' && chunk.delta.argumentsDelta) {
          generationTimer.record(performance.now());
        }

        switch (chunk.type) {
          case 'text-delta':
            emit({ type: 'delta', content: chunk.text, reasoning: '' });
            break;
          case 'reasoning-delta':
            emit({ type: 'delta', content: '', reasoning: chunk.text });
            break;
          case 'tool-call-delta':
            accumulateToolCallDelta(toolCallAccumulator, {
              index: chunk.delta.index,
              id: chunk.delta.id,
              name: chunk.delta.name,
              arguments: chunk.delta.argumentsDelta
            }, { appendArguments: true });
            break;
          case 'usage':
            finalUsage = chunk.usage;
            break;
          case 'provider-state':
            providerState = chunk.state;
            break;
          case 'finish':
             if (chunk.reason.kind === 'error') throw new LlmStreamError(chunk.reason.failure);
            break;
        }
      }

      if (abortController.signal.aborted) {
        emit({ type: 'cancelled' });
        return;
      }

      const finalToolCalls = finalizeToolCalls(toolCallAccumulator);
      // The window between the first and last output event — not the moment the
      // stream closed, which is later by however long the provider took to
      // finish talking. Timings read this as generation time.
      const outputStreamMs = generationTimer.duration();
      if (finalUsage && outputStreamMs !== undefined) {
        finalUsage = { ...finalUsage, timings: { ...finalUsage.timings, output_stream_ms: outputStreamMs } };
      }
      emit({ type: 'done', toolCalls: finalToolCalls, usage: finalUsage, providerState });
    } catch (error) {
      if (abortController.signal.aborted) {
        emit({ type: 'cancelled' });
      } else {
        const failure = classifyError(error);
        emit({ type: 'error', error: failure.message, errorCode: failure.code });
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
  const rustEntry = rustStreams.get(key);
  if (rustEntry) {
    rustEntry.cancelled = true;
    clearTimeout(rustEntry.timeout);
    rustStreams.delete(key);
    rustEntry.emit({ type: 'cancelled' });
    await rustEntry.client.request('llm.cancel', { stream_id: key }).catch(() => {});
    return { cancelled: true };
  }
  const controller = activeStreams.get(key);
  if (!controller) return { cancelled: false };
  controller.abort();
  activeStreams.delete(key);
  return { cancelled: true };
}
