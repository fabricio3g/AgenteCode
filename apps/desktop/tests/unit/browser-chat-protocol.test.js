import { describe, it } from 'node:test';
import assert from 'node:assert';

import { withoutPageContext, withPageContext } from '../../shared/browser/chat-protocol.ts';

// The browser chat folds the page into the prompt the model reads, and the
// history view strips it back out: the two must be exact inverses.

describe('browser chat page context', () => {
  const page = { url: 'https://example.com/a', title: 'Example', selection: 'a quoted line' };

  it('puts the tab and the selection before the message, marked untrusted', () => {
    const text = withPageContext('Summarize this', page);
    assert.ok(text.startsWith('[Browser tab: Example — https://example.com/a]'));
    assert.match(text, /untrusted/);
    assert.match(text, /a quoted line/);
    assert.ok(text.endsWith('\n\nSummarize this'));
  });

  it('round-trips back to the words the person typed', () => {
    for (const message of ['Summarize this', 'Line one\n\nLine two']) {
      assert.strictEqual(withoutPageContext(withPageContext(message, page)), message);
      assert.strictEqual(withoutPageContext(withPageContext(message, { url: page.url, title: '' })), message);
      assert.strictEqual(withoutPageContext(withPageContext(message, { ...page, selection: 'para one\n\n\npara two' })), message);
    }
  });

  it('leaves messages without a page alone', () => {
    assert.strictEqual(withPageContext('hi'), 'hi');
    assert.strictEqual(withPageContext('hi', { url: '', title: 'x' }), 'hi');
    assert.strictEqual(withoutPageContext('hi\n\nthere'), 'hi\n\nthere');
  });

  it('clips a long selection', () => {
    const text = withPageContext('q', { ...page, selection: 'x'.repeat(5000) });
    assert.ok(text.length < 4300);
  });
});
