import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../renderer/src/lib/stores/app-prompts.ts';

describe('time-aware prompts', () => {
  it('adds current clock and calendar context to the system prompt', () => {
    const now = new Date('2026-06-04T12:34:56.000Z');
    const prompt = buildSystemPrompt({ basePrompt: 'Be helpful.', currentDate: now });

    assert.match(prompt, /Current date\/time:/);
    assert.match(prompt, /2026-06-04T12:34:56\.000Z/);
    assert.match(prompt, /calendar questions/);
  });
});
