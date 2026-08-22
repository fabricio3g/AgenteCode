import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDialect } from '../../main/providers/dialects.ts';

const normalize = (url) => getDialect('groq').normalizeBaseUrl(url);

describe('groq base URL normalization', () => {
  it('defaults to the full OpenAI-compat path', () => {
    assert.equal(normalize(), 'https://api.groq.com/openai/v1');
    assert.equal(normalize(''), 'https://api.groq.com/openai/v1');
  });

  it('keeps a single /openai/v1 suffix so SDK paths are not doubled', () => {
    assert.equal(
      normalize('https://api.groq.com/openai/v1'),
      'https://api.groq.com/openai/v1'
    );
    assert.equal(
      normalize('https://api.groq.com/openai/v1/'),
      'https://api.groq.com/openai/v1'
    );
  });

  it('appends the path to host-only URLs', () => {
    assert.equal(normalize('https://api.groq.com'), 'https://api.groq.com/openai/v1');
  });

  it('supports custom proxies', () => {
    assert.equal(
      normalize('https://proxy.example.com/openai/v1'),
      'https://proxy.example.com/openai/v1'
    );
    assert.equal(
      normalize('https://proxy.example.com'),
      'https://proxy.example.com/openai/v1'
    );
  });
});
