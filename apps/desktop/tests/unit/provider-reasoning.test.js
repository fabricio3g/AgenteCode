import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getDialect } from '../../main/providers/dialects.ts';

const reasoningBody = (id, level, modelId) => getDialect(id).reasoningBody(level, modelId);

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
