import type { CodeSpend } from './agente-protocol.ts';
import type { RuntimeEvent } from './agente-protocol.gen.ts';

export function emptySpend(): CodeSpend {
  return { costUsd: 0, estimated: false, unpriced: false, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Fold each call once; turn-level usage snapshots are never spend. */
export function addCallSpend(spend: CodeSpend, call: Extract<RuntimeEvent, { type: 'call_usage' }>): void {
  const priced = typeof call.cost_usd === 'number' && Number.isFinite(call.cost_usd) && call.cost_usd >= 0;
  spend.costUsd += priced ? call.cost_usd! : 0;
  spend.estimated ||= call.cost_estimated;
  spend.unpriced ||= !priced;
  spend.promptTokens += call.usage.prompt_tokens;
  spend.cacheReadTokens += call.usage.cache_read_tokens;
  spend.cacheWriteTokens += call.usage.cache_creation_tokens;
}
