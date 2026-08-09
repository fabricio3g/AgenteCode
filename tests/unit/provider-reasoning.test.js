import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mapAnthropicThinkingBody } from '../../main/providers/anthropic.ts';
import { mapGeminiThinkingConfig } from '../../main/providers/gemini.ts';
import { mapGroqReasoningBody } from '../../main/providers/groq.ts';
import { mapOpenRouterReasoningBody } from '../../main/providers/openrouter.ts';
import { mapMistralReasoningBody } from '../../main/providers/mistral.ts';
import { mapDeepSeekReasoningBody } from '../../main/providers/deepseek.ts';

describe('Anthropic adaptive thinking body', () => {
  it('omits body for off', () => {
    assert.deepEqual(mapAnthropicThinkingBody({ level: 'off' }), {});
    assert.deepEqual(mapAnthropicThinkingBody(undefined), {});
  });

  it('disables thinking', () => {
    assert.deepEqual(mapAnthropicThinkingBody({ level: 'disabled' }), {
      thinking: { type: 'disabled' }
    });
  });

  it('uses adaptive + effort for low/medium/high/max', () => {
    assert.deepEqual(mapAnthropicThinkingBody({ level: 'low' }), {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' }
    });
    assert.deepEqual(mapAnthropicThinkingBody({ level: 'high' }), {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' }
    });
    assert.deepEqual(mapAnthropicThinkingBody({ level: 'max' }), {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' }
    });
  });

  it('keeps legacy enabled + budget_tokens', () => {
    const body = mapAnthropicThinkingBody({ level: 'enabled' }, 16000);
    assert.equal(body.thinking.type, 'enabled');
    assert.ok(body.thinking.budget_tokens >= 1024);
    assert.ok(body.thinking.budget_tokens < 16000);
  });
});

describe('Gemini thinking config', () => {
  it('uses thinkingLevel for Gemini 3', () => {
    const body = mapGeminiThinkingConfig({ level: 'low' }, 'gemini-3.6-flash');
    assert.ok(body.thinkingLevel);
    assert.equal(body.includeThoughts, true);
  });

  it('uses thinkingBudget for Gemini 2.5', () => {
    const body = mapGeminiThinkingConfig({ level: 'medium' }, 'gemini-2.5-flash');
    assert.equal(body.thinkingBudget, 8192);
    assert.equal(body.includeThoughts, true);
  });

  it('disables via budget 0 on 2.5', () => {
    const body = mapGeminiThinkingConfig({ level: 'off' }, 'gemini-2.5-flash');
    assert.equal(body.thinkingBudget, 0);
  });
});

describe('Groq reasoning body', () => {
  it('sends effort for GPT-OSS', () => {
    assert.deepEqual(mapGroqReasoningBody({ level: 'high' }, 'openai/gpt-oss-120b'), {
      reasoning_effort: 'high',
      include_reasoning: true
    });
  });

  it('sends none/default for Qwen', () => {
    assert.deepEqual(mapGroqReasoningBody({ level: 'none' }, 'qwen/qwen3.6-27b'), {
      reasoning_effort: 'none',
      include_reasoning: true
    });
    assert.deepEqual(mapGroqReasoningBody({ level: 'default' }, 'qwen/qwen3.6-27b'), {
      reasoning_effort: 'default',
      include_reasoning: true
    });
  });

  it('returns empty when off or unknown model', () => {
    assert.deepEqual(mapGroqReasoningBody({ level: 'off' }, 'openai/gpt-oss-20b'), {});
    assert.deepEqual(mapGroqReasoningBody({ level: 'high' }, 'llama-3.3-70b'), {});
  });
});

describe('OpenRouter reasoning body', () => {
  it('uses unified reasoning.effort object', () => {
    assert.deepEqual(mapOpenRouterReasoningBody({ level: 'high' }), {
      reasoning: { effort: 'high' }
    });
    assert.deepEqual(mapOpenRouterReasoningBody({ level: 'none' }), {
      reasoning: { effort: 'none' }
    });
  });

  it('omits for off', () => {
    assert.deepEqual(mapOpenRouterReasoningBody({ level: 'off' }), {});
  });
});

describe('Mistral reasoning body', () => {
  it('maps high/none via SDK camelCase field', () => {
    assert.deepEqual(mapMistralReasoningBody({ level: 'high' }), {
      reasoningEffort: 'high'
    });
    assert.deepEqual(mapMistralReasoningBody({ level: 'none' }), {
      reasoningEffort: 'none'
    });
  });
});

describe('DeepSeek still correct after shared openai bump', () => {
  it('disables and enables with high/max', () => {
    assert.deepEqual(mapDeepSeekReasoningBody({ level: 'off' }), {
      thinking: { type: 'disabled' }
    });
    assert.deepEqual(mapDeepSeekReasoningBody({ level: 'max' }), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'max'
    });
  });
});
