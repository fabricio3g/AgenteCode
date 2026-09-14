// ── Tool-support probe ─────────────────────────────────────────────────
// One lightweight complete() call with a calculator tool answers "does this
// route accept function calling at all". Shared by every adapter.

import type { CompletionResult, StreamParams } from './protocol.ts';

export interface ToolProbeArgs {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  modelPath?: string;
  providerName?: string;
}

export async function probeToolSupport(
  complete: (params: StreamParams) => Promise<CompletionResult>,
  args: ToolProbeArgs
): Promise<{ supportsTools: boolean; source: string }> {
  try {
    const result = await complete({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model || 'default',
      messages: [
        { role: 'system', content: 'You are a helpful assistant. If tools are available, use them when appropriate.' },
        { role: 'user', content: 'What is 2+2? Just return the number.' }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'calculator',
          description: 'Evaluate a math expression',
          parameters: {
            type: 'object',
            properties: { expression: { type: 'string', description: 'Expression to evaluate' } },
            required: ['expression']
          }
        }
      }],
      signal: AbortSignal.timeout(12000)
    });
    return { supportsTools: !!(result.toolCalls?.length || result.content), source: 'probe' };
  } catch (err: unknown) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    // Transient failures say nothing about tools — let the caller proceed and
    // fail over at runtime instead of caching a negative for the session.
    if (/unauthor|api key|api-key|401|403|503|network|timeout|econn|fetch failed|load failed/.test(msg)) {
      return { supportsTools: true, source: 'probe_fallback' };
    }
    if (/tool|function.?call|unsupported|not.?support|requires --jinja/.test(msg)) {
      return { supportsTools: false, source: 'probe_rejected' };
    }
    // Auth/network failures say nothing about tools — let the caller proceed.
    return { supportsTools: true, source: 'probe_fallback' };
  }
}
