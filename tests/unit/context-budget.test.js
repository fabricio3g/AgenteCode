import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackContextBudget, estimateTokensFromMessages, inferContextWindowFromModel } from '../../renderer/src/lib/stores/app-context-budget.ts';

describe('context budget fallback', () => {
  it('estimates prompt usage when provider metadata is unavailable', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Summarize the current project context.' }
    ];

    const budget = buildFallbackContextBudget({ messages, contextWindow: 8192, maxTokens: 1024 });

    assert.equal(budget.maxContext, 8192);
    assert.equal(budget.reservedForCompletion, 1024);
    assert.equal(budget.usedTokens, estimateTokensFromMessages(messages));
    assert.ok(budget.usedTokens > 0);
    assert.ok(budget.remaining > 0);
  });

  it('uses the full context window for fallback usage percentage', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(4000) }];
    const budget = buildFallbackContextBudget({ messages, contextWindow: 2000, maxTokens: 500 });

    assert.equal(budget.maxContext, 2000);
    assert.equal(budget.usagePercent, Math.min(100, Math.round((budget.usedTokens / budget.maxContext) * 100)));
    assert.equal(budget.remaining, Math.max(0, budget.maxContext - budget.reservedForCompletion - budget.usedTokens));
  });

  it('infers common API model context windows without multiplying max output tokens', () => {
    assert.equal(inferContextWindowFromModel('anthropic', 'claude-sonnet-4-20250514'), 200000);
    assert.equal(inferContextWindowFromModel('openai', 'gpt-4o-mini'), 128000);
    assert.equal(inferContextWindowFromModel('openai', 'unknown-model'), null);
  });
});
