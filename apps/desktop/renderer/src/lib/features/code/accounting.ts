import type { CodeSpend } from '$shared/agente-protocol';
import type { ChatMessage } from '$lib/types/chat';
import { emptySpend } from './code-run';

/** Saved turns plus the live turn, which already includes its children. */
export function conversationSpend(messages: ChatMessage[], live?: { assistantMessageId?: string; spend: CodeSpend }): CodeSpend {
  const total = emptySpend();
  for (const message of messages) {
    const spend = message.id === live?.assistantMessageId ? live.spend : message.metadata?.codeSpend;
    if (message.role !== 'assistant' || !spend) continue;
    total.costUsd += spend.costUsd;
    total.promptTokens += spend.promptTokens;
    total.cacheReadTokens += spend.cacheReadTokens;
    total.cacheWriteTokens += spend.cacheWriteTokens;
    total.estimated ||= spend.estimated;
    total.unpriced ||= spend.unpriced;
  }
  return total;
}

/** Only reported spend/cache data appears; missing pricing is explicit. */
export function spendLabel(spend: CodeSpend): string {
  const parts: string[] = [];
  const cost = spendCostLabel(spend);
  if (cost) parts.push(cost);
  const context = spend.promptTokens + spend.cacheReadTokens + spend.cacheWriteTokens;
  if (spend.cacheReadTokens > 0 && context > 0) parts.push(`${Math.floor(spend.cacheReadTokens * 100 / context)}% cached`);
  return parts.join(' · ');
}

/**
 * Just the money, for a row's one meta line — the cache rate belongs to the
 * detail, where there is room to say what it is a rate of.
 */
export function spendCostLabel(spend: CodeSpend): string {
  if (spend.costUsd > 0) {
    const amount = spend.costUsd < 0.001 ? '<$0.001' : `$${spend.costUsd.toFixed(3)}`;
    return `${spend.estimated ? '~' : ''}${amount}${spend.unpriced ? '+' : ''}`;
  }
  if (!spend.unpriced && spend.promptTokens + spend.cacheReadTokens + spend.cacheWriteTokens > 0) {
    return spend.estimated ? '~$0' : 'free';
  }
  return '';
}
