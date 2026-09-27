import { describe, it } from 'node:test';
import assert from 'node:assert';

import { toWireMessages } from '../../main/agente/llm/stream-fn.ts';

const shot = { data: 'AAAA', mimeType: 'image/png' };
const call = (id) => ({ id, name: 'browser_screenshot', arguments: {} });

describe('toWireMessages with tool images', () => {
  it('sends the latest batch images as one user message after all its tool results', () => {
    const wire = toWireMessages([
      { role: 'user', content: 'check the page', ts: 1 },
      { role: 'assistant', content: '', toolCalls: [call('a'), call('b')], ts: 2 },
      { role: 'tool', toolCallId: 'a', toolName: 'browser_screenshot', content: 'shot a', isError: false, images: [shot], ts: 3 },
      { role: 'tool', toolCallId: 'b', toolName: 'browser_snapshot', content: 'tree', isError: false, ts: 4 }
    ]);
    assert.deepStrictEqual(wire.map((message) => message.role), ['user', 'assistant', 'tool', 'tool', 'user']);
    const images = wire[4].content;
    assert.strictEqual(images[1].type, 'image_url');
    assert.strictEqual(images[1].image_url.url, 'data:image/png;base64,AAAA');
  });

  it('drops images from earlier batches and says so', () => {
    const wire = toWireMessages([
      { role: 'assistant', content: '', toolCalls: [call('a')], ts: 1 },
      { role: 'tool', toolCallId: 'a', toolName: 'browser_screenshot', content: 'shot a', isError: false, images: [shot], ts: 2 },
      { role: 'assistant', content: 'looks fine', ts: 3 }
    ]);
    assert.deepStrictEqual(wire.map((message) => message.role), ['assistant', 'tool', 'assistant']);
    assert.match(wire[1].content, /Earlier screenshot omitted/);
  });
});
