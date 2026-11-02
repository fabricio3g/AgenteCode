import type { CodeSpend } from '$shared/agente-protocol';
import type { ChatMessage } from '$lib/types/chat';
import { formatUsd } from '$lib/utils/money';
import { emptySpend } from '$shared/accounting';

/** Saved turns plus the live turn, which already includes its children. */
export function conversationSpend(messages: ChatMessage[], live?: { assistantMessageId?: string; spend: CodeSpend }): CodeSpend {
  const total = emptySpend();
  for (const message of messages) {
    const metadata = message.status === 'streaming' ? message.metadata
      : message.versions?.[message.activeVersion ?? 0]?.metadata ?? message.metadata;
    const spend = message.id === live?.assistantMessageId ? live.spend : metadata?.codeSpend;
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
 *
 * `~` means at least one call in the total was our catalog estimate, `+` means
 * at least one call had no price at all, `free` means every call was priced
 * and the provider charged nothing. Those characters come from the same flags
 * the TUI's `Spend::cost_label` prints, and the amount from the same rule, so
 * one session reads the same on both surfaces.
 */
export function spendCostLabel(spend: CodeSpend): string {
  const tokens = spend.promptTokens + spend.cacheReadTokens + spend.cacheWriteTokens;
  if (spend.costUsd > 0) {
    return `${spend.estimated ? '~' : ''}${formatUsd(spend.costUsd)}${spend.unpriced ? '+' : ''}`;
  }
  if (!spend.unpriced && tokens > 0) {
    return spend.estimated ? `~${formatUsd(0)}` : 'free';
  }
  return '';
}
