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

  it('infers modern model families used by the app', () => {
    assert.equal(inferContextWindowFromModel('deepseek', 'deepseek-v4-flash'), 1_000_000);
    assert.equal(inferContextWindowFromModel('deepseek', 'deepseek-v4-pro'), 1_000_000);
    assert.equal(inferContextWindowFromModel('openai', 'gpt-5.6'), 400_000);
    assert.equal(inferContextWindowFromModel('gemini', 'gemini-2.5-pro'), 1_000_000);
    assert.equal(inferContextWindowFromModel('openrouter', 'google/gemma-4-31b-it:free'), 128_000);
    assert.equal(inferContextWindowFromModel('groq', 'qwen/qwen3-32b'), 131_072);
    assert.equal(inferContextWindowFromModel('groq', 'openai/gpt-oss-120b'), 131_072);
  });
});

describe('context budget ring max sources', () => {
  it('local fallback uses config context_length as maxContext', () => {
    const budget = buildFallbackContextBudget({
      messages: [{ role: 'user', content: 'hello' }],
      contextWindow: 8192,
      maxTokens: 1024
    });
    assert.equal(budget.maxContext, 8192);
  });

  it('api budget uses metadata context_window as ring max', async () => {
    const { buildApiContextBudget } = await import('../../renderer/src/lib/stores/app-context-budget.ts');
    const budget = buildApiContextBudget({
      totalTokens: 50,
      contextWindow: 128000,
      providerMaxTokens: 2048,
      modelMetadata: { context_window: 128000 }
    });
    assert.equal(budget.maxContext, 128000);
    assert.equal(budget.usedTokens, 50);
  });

  it('api fallback uses inferred window when metadata is missing', () => {
    const inferred = inferContextWindowFromModel('deepseek', 'deepseek-v4-flash') || 4096;
    const budget = buildFallbackContextBudget({
      messages: [{ role: 'user', content: 'hi' }],
      contextWindow: inferred
    });
    assert.equal(budget.maxContext, 1_000_000);
  });
});

