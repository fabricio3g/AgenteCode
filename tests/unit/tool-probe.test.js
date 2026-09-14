import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { probeToolSupport } from '../../main/providers/tool-probe.ts';

const args = { baseUrl: 'http://127.0.0.1:11435/v1', apiKey: '', model: 'local-model' };

describe('tool-support probe verdicts', () => {
  it('reports tool use when the model calls the probe tool', async () => {
    const complete = async () => ({
      content: '',
      toolCalls: [{ id: 'c1', name: 'calculator', arguments: { expression: '2+2' } }]
    });
    const result = await probeToolSupport(complete, args);
    assert.equal(result.supportsTools, true);
    assert.equal(result.source, 'probe');
  });

  it('reports success when the server accepts tools and answers in text', async () => {
    // Accepting the tools parameter is the actual signal: whether the model
    // chooses to call is decided per turn by the agent loop.
    const complete = async () => ({ content: '4' });
    const result = await probeToolSupport(complete, args);
    assert.equal(result.supportsTools, true);
    assert.equal(result.source, 'probe');
  });

  it('reports no support when the route rejects the tools parameter', async () => {
    const complete = async () => {
      throw new Error('tools param requires --jinja flag');
    };
    const result = await probeToolSupport(complete, args);
    assert.equal(result.supportsTools, false);
    assert.equal(result.source, 'probe_rejected');
  });

  it('stays inconclusive on auth failures instead of caching a negative', async () => {
    const complete = async () => {
      throw new Error('Invalid API Key');
    };
    const result = await probeToolSupport(complete, args);
    assert.equal(result.supportsTools, true);
    assert.equal(result.source, 'probe_fallback');
  });

  it('stays inconclusive on network failures instead of caching a negative', async () => {
    const complete = async () => {
      throw new Error('fetch failed');
    };
    const result = await probeToolSupport(complete, args);
    assert.equal(result.supportsTools, true);
    assert.equal(result.source, 'probe_fallback');
  });
});
