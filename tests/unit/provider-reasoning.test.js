import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mapThinkingBody } from '../../main/providers/anthropic.ts';
import { mapThinkingConfig } from '../../main/providers/gemini.ts';
import { getDialect } from '../../main/providers/dialects.ts';

const reasoningBody = (id, level, modelId) => getDialect(id).reasoningBody(level, modelId);

describe('Anthropic adaptive thinking body', () => {
  it('distinguishes explicit off from the provider default', () => {
    assert.deepEqual(mapThinkingBody({ level: 'off' }), { thinking: { type: 'disabled' } });
    assert.deepEqual(mapThinkingBody(undefined), {});
  });

  it('disables thinking', () => {
    assert.deepEqual(mapThinkingBody({ level: 'disabled' }), {
      thinking: { type: 'disabled' }
    });
  });

  it('uses adaptive + effort for low/medium/high/max', () => {
    assert.deepEqual(mapThinkingBody({ level: 'low' }), {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' }
    });
    assert.deepEqual(mapThinkingBody({ level: 'high' }), {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' }
    });
    assert.deepEqual(mapThinkingBody({ level: 'max' }), {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' }
    });
  });

  it('keeps legacy enabled + budget_tokens', () => {
    const body = mapThinkingBody({ level: 'enabled' }, 16000);
    assert.equal(body.thinking.type, 'enabled');
    assert.ok(body.thinking.budget_tokens >= 1024);
    assert.ok(body.thinking.budget_tokens < 16000);
  });
});

describe('Gemini thinking config', () => {
  it('uses thinkingLevel for Gemini 3', () => {
    const body = mapThinkingConfig({ level: 'low' }, 'gemini-3.6-flash');
    assert.ok(body.thinkingLevel);
    assert.equal(body.includeThoughts, true);
  });

  it('uses thinkingBudget for Gemini 2.5', () => {
    const body = mapThinkingConfig({ level: 'medium' }, 'gemini-2.5-flash');
    assert.equal(body.thinkingBudget, 8192);
    assert.equal(body.includeThoughts, true);
  });

  it('disables via budget 0 on 2.5', () => {
    const body = mapThinkingConfig({ level: 'off' }, 'gemini-2.5-flash');
    assert.equal(body.thinkingBudget, 0);
  });
});

describe('Groq reasoning body (family-aware dialect)', () => {
  it('sends effort for GPT-OSS', () => {
    assert.deepEqual(reasoningBody('groq', 'high', 'openai/gpt-oss-120b'), {
      reasoning_effort: 'high',
      include_reasoning: true
    });
  });

  it('sends none/default for Qwen', () => {
    assert.deepEqual(reasoningBody('groq', 'none', 'qwen/qwen3.6-27b'), {
      reasoning_effort: 'none',
      reasoning_format: 'parsed'
    });
    assert.deepEqual(reasoningBody('groq', 'default', 'qwen/qwen3.6-27b'), {
      reasoning_effort: 'default',
      reasoning_format: 'parsed'
    });
  });

  it('returns empty when off or unknown model', () => {
    assert.deepEqual(reasoningBody('groq', 'off', 'openai/gpt-oss-20b'), {});
    assert.deepEqual(reasoningBody('groq', 'high', 'llama-3.3-70b'), {});
  });
});

describe('OpenRouter reasoning body', () => {
  it('uses unified reasoning.effort object', () => {
    assert.deepEqual(reasoningBody('openrouter', 'high'), {
      reasoning: { effort: 'high' }
    });
    assert.deepEqual(reasoningBody('openrouter', 'none'), {
      reasoning: { effort: 'none' }
    });
  });

  it('disables for off, preserves Auto, and maps enabled to medium', () => {
    assert.deepEqual(reasoningBody('openrouter', 'off'), { reasoning: { effort: 'none' } });
    assert.deepEqual(reasoningBody('openrouter', undefined), {});
    assert.deepEqual(reasoningBody('openrouter', 'enabled'), {
      reasoning: { effort: 'medium' }
    });
  });
});

describe('Mistral reasoning body', () => {
  it('maps high/none via SDK camelCase field', () => {
    assert.deepEqual(reasoningBody('mistral', 'high'), {
      reasoningEffort: 'high'
    });
    assert.deepEqual(reasoningBody('mistral', 'none'), {
      reasoningEffort: 'none'
    });
  });
});

describe('DeepSeek thinking body (official thinking_mode docs)', () => {
  it('disables and enables with high/max', () => {
    assert.deepEqual(reasoningBody('deepseek', 'off'), {
      thinking: { type: 'disabled' }
    });
    assert.deepEqual(reasoningBody('deepseek', 'max'), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'max'
    });
  });
});
