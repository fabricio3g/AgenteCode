import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapDeepSeekReasoningBody } from '../../main/providers/deepseek.ts';

describe('DeepSeek reasoning body (official thinking_mode docs)', () => {
  it('disables thinking for off / disabled / minimal', () => {
    assert.deepEqual(mapDeepSeekReasoningBody({ level: 'off' }), { thinking: { type: 'disabled' } });
    assert.deepEqual(mapDeepSeekReasoningBody({ level: 'disabled' }), { thinking: { type: 'disabled' } });
    assert.deepEqual(mapDeepSeekReasoningBody({ level: 'minimal' }), { thinking: { type: 'disabled' } });
    assert.deepEqual(mapDeepSeekReasoningBody(undefined), { thinking: { type: 'disabled' } });
  });

  it('enables thinking with high effort', () => {
    assert.deepEqual(mapDeepSeekReasoningBody({ level: 'high' }), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    });
    // low/medium map to high per DeepSeek docs
    assert.deepEqual(mapDeepSeekReasoningBody({ level: 'low' }), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    });
    assert.deepEqual(mapDeepSeekReasoningBody({ level: 'medium' }), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    });
  });

  it('enables thinking with max effort', () => {
    assert.deepEqual(mapDeepSeekReasoningBody({ level: 'max' }), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'max'
    });
    // xhigh maps to max per docs
    assert.deepEqual(mapDeepSeekReasoningBody({ level: 'xhigh' }), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'max'
    });
  });
});
