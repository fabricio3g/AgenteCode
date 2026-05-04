import { invoke, listen, isTauri } from '$lib/services/tauri';
import { loadAppConfig } from '$lib/utils/storage';
import { toRequestMessages } from '$lib/services/chat-api';
import type { RequestMessage, ToolDefinition, NativeToolCall, CompletionResult } from '$lib/services/chat-api';

export type { RequestMessage, ToolDefinition, NativeToolCall, CompletionResult } from '$lib/services/chat-api';

function shouldDebugAgentLogs(config: any): boolean {
  return !!config?.ui?.agent_debug_logs;
}

function debugLog(enabled: boolean, message: string) {
  if (enabled) console.log(message);
}

export async function agentComplete(options: {
  messages: RequestMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  config?: any;
}): Promise<CompletionResult | null> {
  if (!isTauri()) return null;

  const config = options.config || await loadAppConfig();
  const providerName = config.llm?.provider || 'openai';
  const providers = config.llm?.providers || {};
  const provider = providers[providerName] || { base_url: 'https://api.openai.com/v1', model: '' };
  const apiKey = provider.api_key || '';

  if (!provider.base_url) return null;

  const genParams: Record<string, unknown> = {};
  if (Number.isFinite(provider.temperature)) genParams.temperature = provider.temperature;
  if (provider.max_tokens) genParams.max_tokens = provider.max_tokens;
  if (Number.isFinite(provider.top_p)) genParams.top_p = provider.top_p;

  const body: Record<string, unknown> = {
    model: provider.model,
    stream: false,
    messages: toRequestMessages(options.messages, provider.model),
    ...genParams
  };

  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }

  try {
    const payload = await invoke<any>('chat_complete', {
      baseUrl: provider.base_url,
      apiKey,
      providerName,
      body
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
  const providerName = config.llm?.provider || 'openai';
  const providers = config.llm?.providers || {};
  const provider = providers[providerName] || { base_url: 'https://api.openai.com/v1', model: '' };
  const apiKey = provider.api_key || '';
  const debugLogs = shouldDebugAgentLogs(config);

  if (!provider.base_url) {
    debugLog(debugLogs, '[agent-llm] agentStreamComplete ABORT | no base_url for provider');
    return null;
  }

  debugLog(debugLogs, `[agent-llm] agentStreamComplete | model=${provider.model} | messages=${options.messages.length} | tools=${options.tools?.length ?? 0} | provider=${providerName}`);

  const genParams: Record<string, unknown> = {};
  if (Number.isFinite(provider.temperature)) genParams.temperature = provider.temperature;
  if (provider.max_tokens) genParams.max_tokens = provider.max_tokens;
  if (Number.isFinite(provider.top_p)) genParams.top_p = provider.top_p;

  const body: Record<string, unknown> = {
    model: provider.model,
    stream: true,
    messages: toRequestMessages(options.messages, provider.model),
    ...genParams
  };

  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }

  let streamId = '';
  let resolveStream: (() => void) | null = null;
  let rejectStream: ((error: Error) => void) | null = null;
  let finalResult: CompletionResult = { content: '', reasoning: '' };

  const streamPromise = new Promise<void>((resolve, reject) => {
    resolveStream = resolve;
    rejectStream = reject;
  });

  const off = await listen<any>('chat-stream-event', (event) => {
    if (!event || event.streamId !== streamId) return;

    if (event.type !== 'delta') {
      debugLog(debugLogs, `[agent-llm] stream event | type=${event.type} | streamId=${streamId.slice(0, 8)}...`);
    }

    if (event.type === 'delta') {
      if (event.reasoning) {
        finalResult.reasoning += String(event.reasoning);
        options.onReasoning?.(String(event.reasoning));
      }
      if (event.content) {
        finalResult.content += String(event.content);
        options.onContent?.(String(event.content));
      }
      return;
    }

    if (event.type === 'done') {
      debugLog(debugLogs, `[agent-llm] stream done | contentLen=${finalResult.content.length} | reasoningLen=${finalResult.reasoning.length} | toolCalls=${event.toolCalls?.length ?? 0}${event.toolCalls?.length ? ' names=[' + event.toolCalls.map((tc: any) => tc.name || tc.function?.name || '?').join(',') + ']' : ''}`);
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
      baseUrl: provider.base_url,
      apiKey,
      providerName,
      body
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
    toolCalls: toolCalls.length ? toolCalls : undefined
  };
}

export { supportsNativeTools } from '$lib/services/chat-api';
