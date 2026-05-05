import { invoke, listen, isTauri } from '$lib/services/tauri';
import { ensureLocalRuntime, resolveLocalBaseUrl } from '$lib/services/runtime';
import { createBufferedStreamDispatcher } from '$lib/services/streaming';
import { loadAppConfig } from '$lib/utils/storage';
import { hasConfiguredVisionModel, toRequestMessages } from '$lib/services/chat-api';
import type { AppConfig } from '$lib/types/chat';
import type { RequestMessage, ToolDefinition, NativeToolCall, CompletionResult } from '$lib/services/chat-api';

export type { RequestMessage, ToolDefinition, NativeToolCall, CompletionResult } from '$lib/services/chat-api';

function shouldDebugAgentLogs(config: any): boolean {
  return !!config?.ui?.agent_debug_logs;
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
        ...(Number.isFinite((local as any).top_p) ? { top_p: (local as any).top_p } : {})
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
  options: { messages: RequestMessage[]; tools?: ToolDefinition[]; stream: boolean }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: transport.model,
    stream: options.stream,
    messages: toRequestMessages(options.messages, transport.modelForMessages, transport.visionCapable),
    ...transport.params
  };

  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }

  return body;
}

export async function agentComplete(options: {
  messages: RequestMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  config?: any;
}): Promise<CompletionResult | null> {
  if (!isTauri()) return null;

  const config = options.config || await loadAppConfig();
  const debugLogs = shouldDebugAgentLogs(config);
  const transport = await resolveAgentTransport(config);
  if (!transport) return null;
  debugLog(debugLogs, `[agent-llm] route | backend=${transport.backend} | transport=${transport.transport} | model=${transport.model} | stream=false`);

  try {
    const payload = await invoke<any>('chat_complete', {
      baseUrl: transport.baseUrl,
      apiKey: transport.apiKey,
      providerName: transport.providerName,
      body: buildBody(transport, { messages: options.messages, tools: options.tools, stream: false })
    });

    return readCompletionWithTools(payload);
  } catch (err) {
    console.warn('[agent-llm] agentComplete failed:', err);
    return null;
  }
}

export async function agentStreamComplete(options: {
  messages: RequestMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  config?: any;
  onReasoning?: (text: string) => void;
  onContent?: (text: string) => void;
}): Promise<CompletionResult | null> {
  if (!isTauri()) return null;

  const config = options.config || await loadAppConfig();
  const debugLogs = shouldDebugAgentLogs(config);
  const transport = await resolveAgentTransport(config);
  if (!transport) {
    debugLog(debugLogs, '[agent-llm] agentStreamComplete ABORT | no base_url for provider');
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
    delayMs: transport.backend === 'local' ? 55 : 40
  });

  const off = await listen<any>('chat-stream-event', (event) => {
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
      debugLog(debugLogs, `[agent-llm] stream done | contentLen=${finalResult.content.length} | reasoningLen=${finalResult.reasoning.length} | toolCalls=${event.toolCalls?.length ?? 0}${event.toolCalls?.length ? ' names=[' + event.toolCalls.map((tc: any) => tc.name || tc.function?.name || '?').join(',') + ']' : ''}`);
      if (event.usage) {
        finalResult.usage = event.usage;
      }
      if (event.toolCalls?.length) {
        finalResult.toolCalls = event.toolCalls.map((tc: any) => ({
          id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
          name: String(tc.name || ''),
          arguments: typeof tc.arguments === 'string'
            ? (parseJson(tc.arguments) || {})
            : (tc.arguments || {})
        })).filter((tc: NativeToolCall) => !!tc.name);
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
      rejectStream?.(new Error(event.error || 'Streaming request failed'));
    }
  });

  let abortListener: (() => void) | null = null;

  try {
    const started = await invoke<{ streamId: string }>('chat_stream_start', {
      baseUrl: transport.baseUrl,
      apiKey: transport.apiKey,
      providerName: transport.providerName,
      body: buildBody(transport, { messages: options.messages, tools: options.tools, stream: true })
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
  } catch (err) {
    const errStr = String(err);
    const isCloneError = errStr.includes('could not be cloned') || errStr.includes('DataCloneError');
    debugLog(debugLogs, `[agent-llm] agentStreamComplete FAILED | err=${errStr.slice(0, 200)} | hasPartialContent=${!!(finalResult.content || finalResult.toolCalls?.length)} | isCloneError=${isCloneError}`);
    console.warn('[agent-llm] agentStreamComplete failed:', err);
    if (finalResult.content || finalResult.toolCalls?.length) {
      return finalResult;
    }
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

function readCompletionWithTools(payload: any): CompletionResult {
  if (payload && typeof payload === 'object' && typeof payload.content === 'string') {
    const toolCalls: NativeToolCall[] = (payload.toolCalls || []).map((tc: any) => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
      name: String(tc.function?.name || tc.name || ''),
      arguments: (() => {
        if (tc.arguments && typeof tc.arguments === 'object') return tc.arguments;
        try { return JSON.parse(tc.function?.arguments || tc.arguments || '{}'); } catch { return {}; }
      })()
    })).filter((tc: NativeToolCall) => !!tc.name);

    return {
      content: payload.content,
      reasoning: String(payload.reasoning || ''),
      usage: payload.usage || null,
      toolCalls: toolCalls.length ? toolCalls : undefined
    };
  }

  const message = payload?.choices?.[0]?.message || {};
  const toolCalls: NativeToolCall[] = (message.tool_calls || []).map((tc: any) => ({
    id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
    name: String(tc.function?.name || ''),
    arguments: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })()
  })).filter((tc: NativeToolCall) => !!tc.name);

  return {
    content: String(message.content || ''),
    reasoning: String(message.reasoning_content ?? message.reasoning ?? message.thinking ?? ''),
    usage: payload?.usage || null,
    toolCalls: toolCalls.length ? toolCalls : undefined
  };
}

export { supportsNativeTools } from '$lib/services/chat-api';
