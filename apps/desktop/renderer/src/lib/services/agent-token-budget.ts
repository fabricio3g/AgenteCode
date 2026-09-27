import type { RequestMessage } from '$lib/services/chat-api';

export async function enforceTokenBudget(params: {
  messages: RequestMessage[];
  config: unknown;
  isElectron: () => boolean;
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  debugLog: (enabled: boolean, message: string) => void;
}): Promise<void> {
  const { messages, config } = params;
  if (messages.length <= 6) return;

  const cfg = config as {
    llm?: {
      provider?: string;
      providers?: Record<string, { context_length?: number }>;
      local?: { context_length?: number };
    };
    ui?: { agent_debug_logs?: boolean };
  };

  const contextLength = cfg?.llm?.providers?.[cfg?.llm?.provider || '']?.context_length
    || cfg?.llm?.local?.context_length
    || 8192;

  if (!params.isElectron()) {
    const totalChars = messages.reduce(
      (sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0),
      0
    );
    if (totalChars <= contextLength * 2.5) return;
  }

  try {
    const budget = await params.invoke<unknown>('build_context_budget', {
      config: { context_length: contextLength, max_tokens: contextLength },
      messages: messages.map((message) => ({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : (message.content ? JSON.stringify(message.content) : ''),
        ...(message.name ? { name: message.name } : {})
      }))
    });

    const budgetObj = budget as { isOverflow?: boolean; usagePercent?: number };
    if (budgetObj?.isOverflow || (budgetObj?.usagePercent ?? 0) > 80) {
      const truncated = await params.invoke<unknown>('truncate_messages', {
        messages: budgetObj.isOverflow
          ? messages.map((message) => ({
              role: message.role,
              content: typeof message.content === 'string' ? message.content : (message.content ? JSON.stringify(message.content) : ''),
              ...(message.name ? { name: message.name } : {})
            }))
          : [],
        budget: budgetObj
      });

      if (Array.isArray(truncated) && truncated.length > 0 && truncated.length < messages.length) {
        params.debugLog(!!cfg?.ui?.agent_debug_logs, `[agent] Token budget: trimmed ${messages.length} → ${truncated.length} messages (${budgetObj.usagePercent}% used)`);
        messages.splice(0, messages.length, ...(truncated as RequestMessage[]));
      }
    }
  } catch (err: unknown) {
    console.warn('[agent] Token budget enforcement failed, continuing with structural trim only:', err);
  }
}
