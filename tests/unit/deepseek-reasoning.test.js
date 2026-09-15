import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDialect } from '../../main/providers/dialects.ts';

// The dialect table owns the DeepSeek thinking body now.
function reasoningBody(level) {
  return getDialect('deepseek').reasoningBody(level);
}

describe('DeepSeek reasoning body (official thinking_mode docs)', () => {
  it('disables thinking for off / disabled / minimal', () => {
    assert.deepEqual(reasoningBody('off'), { thinking: { type: 'disabled' } });
    assert.deepEqual(reasoningBody('disabled'), { thinking: { type: 'disabled' } });
    assert.deepEqual(reasoningBody('minimal'), { thinking: { type: 'disabled' } });
    assert.deepEqual(reasoningBody(undefined), {});
  });

  it('enables thinking with high effort', () => {
    assert.deepEqual(reasoningBody('high'), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    });
    // low/medium map to high per DeepSeek docs
    assert.deepEqual(reasoningBody('low'), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    });
    assert.deepEqual(reasoningBody('medium'), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    });
  });

  it('enables thinking with max effort', () => {
    assert.deepEqual(reasoningBody('max'), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'max'
    });
    // xhigh maps to max per docs
    assert.deepEqual(reasoningBody('xhigh'), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'max'
    });
  });
});
