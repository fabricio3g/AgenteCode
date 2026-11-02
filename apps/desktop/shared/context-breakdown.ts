import type { ContextBreakdown } from './agente-protocol.ts';

/** Older runtimes do not send category estimates. */
export function contextBreakdown(event: {
  window: number; tool_tokens: number; gap: number;
  system_tokens?: number | null; message_tokens?: number | null;
  tool_result_tokens?: number | null; reserve?: number | null;
}): ContextBreakdown | undefined {
  if (event.system_tokens == null || event.message_tokens == null || event.tool_result_tokens == null) return undefined;
  return { system: event.system_tokens, messages: event.message_tokens, toolResults: event.tool_result_tokens,
    tools: event.tool_tokens, overhead: event.gap, reserve: event.reserve ?? 0, window: event.window };
}
