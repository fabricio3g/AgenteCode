import { invoke, listen, isTauri } from '$lib/services/tauri';
import { ensureLocalRuntime, resolveLocalBaseUrl } from '$lib/services/runtime';
import { createBufferedStreamDispatcher } from '$lib/services/streaming';
import { loadAppConfig } from '$lib/utils/storage';
import { buildReasoningRequest, hasConfiguredVisionModel, toRequestMessages } from '$lib/services/chat-api';
import type { AppConfig, ReasoningLevel } from '$lib/types/chat';
import type { RequestMessage, ToolDefinition, NativeToolCall, CompletionResult } from '$lib/services/chat-api';
import { toErrorMessage } from '$lib/utils/errors';

export type { RequestMessage, ToolDefinition, NativeToolCall, CompletionResult } from '$lib/services/chat-api';

function shouldDebugAgentLogs(config: unknown): boolean {
  return !!(config as { ui?: { agent_debug_logs?: boolean } })?.ui?.agent_debug_logs;
}

function debugLog(enabled: boolean, message: string) {
  if (enabled) console.log(message);
}

type AgentTransport = {
  backend: 'local' | 'api';
  transport: 'local_runtime' | 'provider_ipc';
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelForMessages: string;
  visionCapable?: boolean;
  params: Record<string, unknown>;
};

async function resolveAgentTransport(config: AppConfig): Promise<AgentTransport | null> {
  const backendMode = config.llm?.backend_mode || (isTauri() ? 'local' : 'api');
  if (backendMode === 'local') {
    const runtimeBaseUrl = await ensureLocalRuntime(config);
    const baseUrl = resolveLocalBaseUrl({
      llm: { local: { base_url: runtimeBaseUrl } }
    } as AppConfig);
    const local = config.llm?.local || {};
    return {
      backend: 'local',
      transport: 'local_runtime',
      providerName: 'local',
      baseUrl,
      apiKey: '',
      model: local.model || 'local-model',
      modelForMessages: local.model || '',
      visionCapable: await hasConfiguredVisionModel(config),
      params: {
        ...(Number.isFinite(local.temperature) ? { temperature: local.temperature } : {}),
        ...(local.max_tokens ? { max_tokens: local.max_tokens } : {}),
        ...(Number.isFinite((local as { top_p?: number }).top_p) ? { top_p: (local as { top_p?: number }).top_p } : {})
      }
    };
  }

  const providerName = config.llm?.provider || 'openai';
  const providers = config.llm?.providers || {};
  const provider = providers[providerName] || { base_url: 'https://api.openai.com/v1', model: '' };
  if (!provider.base_url) return null;
  return {
    backend: 'api',
    transport: 'provider_ipc',
    providerName,
    baseUrl: provider.base_url,
    apiKey: provider.api_key || '',
    model: provider.model || '',
    modelForMessages: provider.model || '',
    params: {
      ...(Number.isFinite(provider.temperature) ? { temperature: provider.temperature } : {}),
      ...(provider.max_tokens ? { max_tokens: provider.max_tokens } : {}),
      ...(Number.isFinite(provider.top_p) ? { top_p: provider.top_p } : {})
    }
  };
}

function buildBody(
  transport: AgentTransport,
  options: {
    messages: RequestMessage[];
    tools?: ToolDefinition[];
    stream: boolean;
    reasoningLevel?: ReasoningLevel | null;
    /** Research reports: no max_tokens completion budget. */
    omitMaxTokens?: boolean;
  }
): Record<string, unknown> {
  const params = { ...transport.params };
  if (options.omitMaxTokens) {
    delete params.max_tokens;
  }

  const body: Record<string, unknown> = {
    model: transport.model,
    stream: options.stream,
    messages: toRequestMessages(options.messages, transport.modelForMessages, transport.visionCapable),
    ...params
  };

  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }

  const reasoning = buildReasoningRequest(options.reasoningLevel);
  if (reasoning) {
    body.reasoning = reasoning;
  }

  return body;
}

export async function agentComplete(options: {
  messages: RequestMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  config?: unknown;
  reasoningLevel?: ReasoningLevel | null;
  omitMaxTokens?: boolean;
}): Promise<CompletionResult | null> {
  if (!isTauri()) return null;

  const config = options.config || await loadAppConfig();
  const debugLogs = shouldDebugAgentLogs(config);
  const transport = await resolveAgentTransport(config);
  if (!transport) return null;
  debugLog(debugLogs, `[agent-llm] route | backend=${transport.backend} | transport=${transport.transport} | model=${transport.model} | stream=false`);

  try {
    const payload = await invoke<Record<string, unknown>>('chat_complete', {
      baseUrl: transport.baseUrl,
      apiKey: transport.apiKey,
      providerName: transport.providerName,
      body: buildBody(transport, {
        messages: options.messages,
        tools: options.tools,
        stream: false,
        reasoningLevel: options.reasoningLevel,
        omitMaxTokens: options.omitMaxTokens
      })
    });

    return readCompletionWithTools(payload);
  } catch (err: unknown) {
    console.warn('[agent-llm] agentComplete failed:', toErrorMessage(err));
    return null;
  }
}

export async function agentStreamComplete(options: {
  messages: RequestMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  config?: unknown;
  reasoningLevel?: ReasoningLevel | null;
  omitMaxTokens?: boolean;
  onReasoning?: (text: string) => void;
  onContent?: (text: string) => void;
  /**
   * Receives the real failure reason whenever this returns `null`.
   *
   * The `null` return is deliberately kept — the caller treats it as "native tools
   * did not work, fall back to XML" — but on its own it erased the provider's actual
   * message (a 400 body, a tool rejection, a context overflow). That left the
   * caller's error pattern-matching with nothing to match on, so a model that simply
   * does not support tools was indistinguishable from a network blip.
   */
  onError?: (message: string) => void;
}): Promise<CompletionResult | null> {
  if (!isTauri()) return null;

  const config = options.config || await loadAppConfig();
  const debugLogs = shouldDebugAgentLogs(config);
  const transport = await resolveAgentTransport(config);
  if (!transport) {
    debugLog(debugLogs, '[agent-llm] agentStreamComplete ABORT | no base_url for provider');
    options.onError?.('No base_url is configured for this provider.');
    return null;
  }

  debugLog(debugLogs, `[agent-llm] route | backend=${transport.backend} | transport=${transport.transport} | model=${transport.model} | stream=true | messages=${options.messages.length} | tools=${options.tools?.length ?? 0}`);

  let streamId = '';
  let resolveStream: (() => void) | null = null;
  let rejectStream: ((error: Error) => void) | null = null;
  let finalResult: CompletionResult = { content: '', reasoning: '' };

  const streamPromise = new Promise<void>((resolve, reject) => {
    resolveStream = resolve;
    rejectStream = reject;
  });
  const dispatcher = createBufferedStreamDispatcher({
    onContent: options.onContent,
    onReasoning: options.onReasoning,
    delayMs: 40
  });

  const off = await listen<Record<string, unknown>>('chat-stream-event', (event) => {
    if (!event || event.streamId !== streamId) return;

    if (event.type !== 'delta') {
      debugLog(debugLogs, `[agent-llm] stream event | type=${event.type} | streamId=${streamId.slice(0, 8)}...`);
    }

    if (event.type === 'delta') {
      if (event.reasoning) {
        const nextReasoning = String(event.reasoning);
        finalResult.reasoning += nextReasoning;
        dispatcher.pushReasoning(nextReasoning);
      }
      if (event.content) {
        const nextContent = String(event.content);
        finalResult.content += nextContent;
        dispatcher.pushContent(nextContent);
      }
      return;
    }

    if (event.type === 'done') {
      dispatcher.flush();
      const eventToolCalls = Array.isArray(event.toolCalls) ? event.toolCalls as Array<Record<string, unknown>> : [];
      debugLog(debugLogs, `[agent-llm] stream done | contentLen=${finalResult.content.length} | reasoningLen=${finalResult.reasoning.length} | toolCalls=${eventToolCalls.length}${eventToolCalls.length ? ' names=[' + eventToolCalls.map((tc) => String(tc.name || ((tc.function as Record<string, unknown> | undefined)?.name) || '?')).join(',') + ']' : ''}`);
      if (event.usage) {
        finalResult.usage = event.usage;
      }
      if (eventToolCalls.length) {
        finalResult.toolCalls = eventToolCalls.map((tc) => ({
          id: String(tc.id || `call_${Math.random().toString(36).slice(2, 9)}`),
          name: String(tc.name || ''),
          arguments: typeof tc.arguments === 'string'
            ? (parseJson(tc.arguments) || {})
            : ((tc.arguments as Record<string, unknown>) || {})
        })).filter((toolCall: NativeToolCall) => !!toolCall.name);
      }
      resolveStream?.();
      return;
    }

    if (event.type === 'cancelled') {
      dispatcher.flush();
      resolveStream?.();
      return;
    }

    if (event.type === 'error') {
      rejectStream?.(new Error(typeof event.error === 'string' ? event.error : 'Streaming request failed'));
    }
  });

  let abortListener: (() => void) | null = null;

  try {
    const started = await invoke<{ streamId: string }>('chat_stream_start', {
      baseUrl: transport.baseUrl,
      apiKey: transport.apiKey,
      providerName: transport.providerName,
      body: buildBody(transport, {
        messages: options.messages,
        tools: options.tools,
        stream: true,
        reasoningLevel: options.reasoningLevel,
        omitMaxTokens: options.omitMaxTokens
      })
    });

    streamId = started?.streamId || '';
    if (!streamId) throw new Error('Failed to start agent stream');

    if (options.signal) {
      abortListener = () => {
        void invoke('chat_stream_cancel', { streamId }).catch(() => {});
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    await streamPromise;
    return finalResult;
  } catch (err: unknown) {
    const errStr = toErrorMessage(err);
    const isCloneError = errStr.includes('could not be cloned') || errStr.includes('DataCloneError');
    debugLog(debugLogs, `[agent-llm] agentStreamComplete FAILED | err=${errStr.slice(0, 200)} | hasPartialContent=${!!(finalResult.content || finalResult.toolCalls?.length)} | isCloneError=${isCloneError}`);
    console.warn('[agent-llm] agentStreamComplete failed:', err);
    if (finalResult.content || finalResult.toolCalls?.length) {
      return finalResult;
    }
    options.onError?.(errStr);
    return null;
  } finally {
    dispatcher.dispose();
    off();
    if (options.signal && abortListener) {
      options.signal.removeEventListener('abort', abortListener);
    }
  }
}

function parseJson(str: string): Record<string, unknown> | null {
  try { return JSON.parse(str); } catch { return null; }
}

function readCompletionWithTools(payload: Record<string, unknown>): CompletionResult {
  if (payload && typeof payload === 'object' && typeof payload.content === 'string') {
    const toolCalls: NativeToolCall[] = (Array.isArray(payload.toolCalls) ? payload.toolCalls : []).map((tc) => {
      const call = (tc || {}) as Record<string, unknown>;
      const fn = (call.function as Record<string, unknown> | undefined) || {};
      return {
        id: String(call.id || `call_${Math.random().toString(36).slice(2, 9)}`),
        name: String(fn.name || call.name || ''),
        arguments: (() => {
          if (call.arguments && typeof call.arguments === 'object') return call.arguments as Record<string, unknown>;
          try { return JSON.parse(String(fn.arguments || call.arguments || '{}')); } catch { return {}; }
        })()
      };
    }).filter((toolCall: NativeToolCall) => !!toolCall.name);

    return {
      content: payload.content,
      reasoning: String(payload.reasoning || ''),
      usage: payload.usage || null,
      toolCalls: toolCalls.length ? toolCalls : undefined
    };
  }

  const choices = Array.isArray(payload?.choices) ? payload.choices as Array<Record<string, unknown>> : [];
  const message = (choices[0]?.message as Record<string, unknown> | undefined) || {};
  const toolCalls: NativeToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((tc) => {
    const call = (tc || {}) as Record<string, unknown>;
    const fn = (call.function as Record<string, unknown> | undefined) || {};
    return {
      id: String(call.id || `call_${Math.random().toString(36).slice(2, 9)}`),
      name: String(fn.name || ''),
      arguments: (() => { try { return JSON.parse(String(fn.arguments || '{}')); } catch { return {}; } })()
    };
  }).filter((toolCall: NativeToolCall) => !!toolCall.name);

  return {
    content: String(message.content || ''),
    reasoning: String(message.reasoning_content ?? message.reasoning ?? message.thinking ?? ''),
    usage: payload?.usage || null,
    toolCalls: toolCalls.length ? toolCalls : undefined
  };
}

export { supportsNativeTools } from '$lib/services/chat-api';
