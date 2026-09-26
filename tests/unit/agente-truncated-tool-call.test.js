import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseToolCalls } from '../../main/agente/llm/stream-fn.ts';

describe('parseToolCalls', () => {
  it('flags arguments that are not complete JSON as cut off', () => {
    const { calls, cutOff } = parseToolCalls([
      { id: 'c1', name: 'write', arguments: '{"path":"src/game.js","content":"const level = [\\n' }
    ]);
    assert.equal(cutOff, true);
    assert.deepEqual(calls[0].arguments, {});
  });

  it('parses complete calls and treats empty arguments as none', () => {
    const { calls, cutOff } = parseToolCalls([
      { id: 'c1', name: 'write', arguments: '{"path":"a.txt","content":"ok"}' },
      { id: 'c2', name: 'process_list', arguments: '' }
    ]);
    assert.equal(cutOff, false);
    assert.deepEqual(calls.map((c) => c.arguments), [{ path: 'a.txt', content: 'ok' }, {}]);
  });
});
