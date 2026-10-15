import type { ChatMessage } from '$lib/types/chat';

export function latestGenerationSpeed(messages: readonly ChatMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant' || message.status === 'error') continue;
    const metadata = message.versions?.[message.activeVersion ?? 0]?.metadata ?? message.metadata;
    const rate = metadata?.tokensPerSecond;
    if (!metadata?.error && typeof rate === 'number' && Number.isFinite(rate) && rate > 0) return rate;
  }
  return undefined;
}
