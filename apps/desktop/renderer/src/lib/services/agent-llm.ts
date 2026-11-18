import { invoke, listen, isElectron } from '$lib/services/bridge';
import { ensureLocalRuntime, resolveLocalBaseUrl } from '$lib/services/runtime';
import { createBufferedStreamDispatcher } from '$lib/services/streaming';
import { loadAppConfig } from '$lib/utils/storage';
import { buildReasoningRequest, createChatStreamWatchdog, hasConfiguredVisionModel, readCompletionWithTools, toRequestMessages } from '$lib/services/chat-api';
import type { AppConfig, ReasoningLevel } from '$lib/types/chat';
import type { RequestMessage, ToolDefinition, CompletionResult } from '$lib/services/chat/types';
import { toErrorMessage } from '$lib/utils/errors';
import { samplingParams } from '$shared/llm-params';
import { DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_ID } from '$shared/providers';

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
  const backendMode = config.llm?.backend_mode || (isElectron() ? 'local' : 'api');
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

  const providerName = config.llm?.provider || DEFAULT_PROVIDER_ID;
  const providers = config.llm?.providers || {};
  const provider = providers[providerName] || { base_url: DEFAULT_PROVIDER_BASE_URL, model: '' };
  if (!provider.base_url) return null;
  return {
    backend: 'api',
    transport: 'provider_ipc',
    providerName,
    baseUrl: provider.base_url,
    apiKey: provider.api_key || '',
    model: provider.model || '',
    modelForMessages: provider.model || '',
    params: samplingParams(provider)
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
   * Failure never becomes a successful partial reply. The caller uses the code
   * to retry transient failures and only falls back on actual tool rejections.
   */
  onError?: (message: string, code?: string) => void;
}): Promise<CompletionResult | null> {
  if (!isElectron()) return null;
  options.signal?.throwIfAborted();

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
  let errorCode: string | undefined;

  const streamPromise = new Promise<void>((resolve, reject) => {
    resolveStream = resolve;
    rejectStream = reject;
  });
  const dispatcher = createBufferedStreamDispatcher({
    onContent: options.onContent,
    onReasoning: options.onReasoning,
    delayMs: 40
  });

  // A stream that emits nothing at all (stalled connection, provider ignoring
  // the abort signal) would otherwise leave this promise pending forever.
  const idle = createChatStreamWatchdog(() => streamId, (error) => rejectStream?.(error));

  const off = await listen<Record<string, unknown>>('chat-stream-event', (event) => {
    if (!event || event.streamId !== streamId) return;
    idle.arm();

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
      finalResult.providerState = event.providerState as CompletionResult['providerState'];
      const eventToolCalls = Array.isArray(event.toolCalls) ? event.toolCalls as Array<Record<string, unknown>> : [];
      debugLog(debugLogs, `[agent-llm] stream done | contentLen=${finalResult.content.length} | reasoningLen=${finalResult.reasoning.length} | toolCalls=${eventToolCalls.length}${eventToolCalls.length ? ' names=[' + eventToolCalls.map((tc) => String(tc.name || ((tc.function as Record<string, unknown> | undefined)?.name) || '?')).join(',') + ']' : ''}`);
      if (event.usage) {
        finalResult.usage = event.usage;
      }
      if (eventToolCalls.length) {
        finalResult.toolCalls = readCompletionWithTools({ content: finalResult.content, toolCalls: eventToolCalls }).toolCalls;
      }
      resolveStream?.();
      return;
    }

    if (event.type === 'cancelled') {
      rejectStream?.(new DOMException('Agent task cancelled', 'AbortError'));
      return;
    }

    if (event.type === 'error') {
      errorCode = typeof event.errorCode === 'string' ? event.errorCode : undefined;
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
    idle.arm();

    if (options.signal) {
      abortListener = () => {
        void invoke('chat_stream_cancel', { streamId }).catch(() => {});
        rejectStream?.(new DOMException('Agent task cancelled by user', 'AbortError'));
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
      if (options.signal.aborted) abortListener();
    }

    await streamPromise;
    return finalResult;
  } catch (err: unknown) {
    if (options.signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      throw new DOMException('Agent task cancelled by user', 'AbortError');
    }
    const errStr = toErrorMessage(err);
    const isCloneError = errStr.includes('could not be cloned') || errStr.includes('DataCloneError');
    debugLog(debugLogs, `[agent-llm] agentStreamComplete FAILED | err=${errStr.slice(0, 200)} | hasPartialContent=${!!(finalResult.content || finalResult.toolCalls?.length)} | isCloneError=${isCloneError}`);
    console.warn('[agent-llm] agentStreamComplete failed:', err);
    if (errorCode) options.onError?.(errStr, errorCode);
    else options.onError?.(errStr);
    return null;
  } finally {
    idle.clear();
    dispatcher.dispose();
    off();
    if (options.signal && abortListener) {
      options.signal.removeEventListener('abort', abortListener);
    }
  }
}

export { supportsNativeTools } from '$lib/services/chat-api';
