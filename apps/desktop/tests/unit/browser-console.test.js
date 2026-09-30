import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { debuggerConsoleMessage } from '../../main/browser-console.ts';

describe('browser debugger console records', () => {
  it('keeps argument values and descriptions, including falsy values', () => {
    const result = debuggerConsoleMessage('Runtime.consoleAPICalled', {
      type: 'assert',
      args: [{ value: 0 }, { value: false }, { value: null }, { description: 'Object' }]
    });
    assert.deepEqual(result, { level: 'error', source: 'console', text: '0 false null Object' });
    assert.equal(debuggerConsoleMessage('Runtime.consoleAPICalled', { type: 'constructor' }).level, 'log');
  });

  it('preserves exception descriptions and falls back to a readable summary', () => {
    const cases = [
      [{ exception: { description: 'Error: boom' }, text: 'summary' }, 'Error: boom'],
      [{ text: 'Syntax error' }, 'Syntax error'],
      [undefined, 'Uncaught exception']
    ];
    for (const [exceptionDetails, text] of cases) {
      assert.deepEqual(debuggerConsoleMessage('Runtime.exceptionThrown', { exceptionDetails }), { level: 'error', source: 'exception', text });
    }
  });

  it('ignores cancellations, successful requests and unrelated debugger events', () => {
    assert.equal(debuggerConsoleMessage('Network.loadingFailed', { canceled: true }), null);
    assert.equal(debuggerConsoleMessage('Network.responseReceived', { response: { status: 200 } }), null);
    assert.equal(debuggerConsoleMessage('Page.loadEventFired', {}), null);
  });

  it('shows failed network requests and HTTP error responses', () => {
    assert.deepEqual(debuggerConsoleMessage('Network.loadingFailed', { errorText: 'Disconnected', type: 'Document' }), {
      level: 'error', source: 'network', text: 'Disconnected (Document)'
    });
    assert.deepEqual(debuggerConsoleMessage('Network.responseReceived', { response: { status: 404, url: 'https://example.test/missing' } }), {
      level: 'error', source: 'network', text: 'HTTP 404 https://example.test/missing'
    });
  });
});
