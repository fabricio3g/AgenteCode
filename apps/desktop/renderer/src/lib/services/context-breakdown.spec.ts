import { describe, expect, it } from 'vitest';
import { contextBreakdown } from '$shared/context-breakdown';
import { homeRuntimeBudget, normalizeApiModelMetadata } from '$lib/stores/app-context-budget';

describe('runtime context breakdown', () => {
  it('preserves Rust request categories and accounts for the draft separately', () => {
    const breakdown = contextBreakdown({ window: 10000, tool_tokens: 500, gap: 100,
      system_tokens: 1000, message_tokens: 2000, tool_result_tokens: 300, reserve: 1000 });
    expect(breakdown).toEqual({ system: 1000, messages: 2000, toolResults: 300, tools: 500, overhead: 100, reserve: 1000, window: 10000 });
    expect(homeRuntimeBudget({ contextWindow: 10000, contextTokens: 3900, contextBreakdown: breakdown }, 'draft')?.breakdown?.messages).toBe(2006);
  });

  it('does not invent categories for an older runtime', () => {
    expect(contextBreakdown({ window: 10000, tool_tokens: 500, gap: 100 })).toBeUndefined();
  });

  it('preserves a free model price and rejects invalid rates', () => {
    expect(normalizeApiModelMetadata({ context_window: 10_000, prompt_cost_per_million: 0, completion_cost_per_million: 0 })).toMatchObject({ prompt_cost_per_million: 0, completion_cost_per_million: 0 });
    expect(normalizeApiModelMetadata({ context_window: 10_000, prompt_cost_per_million: -1, completion_cost_per_million: 'invalid' })).toMatchObject({ prompt_cost_per_million: undefined, completion_cost_per_million: undefined });
  });
});
