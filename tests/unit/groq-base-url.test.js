import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGroqBaseUrl } from '../../main/providers/groq.ts';

describe('normalizeGroqBaseUrl', () => {
  it('defaults to host root', () => {
    assert.equal(normalizeGroqBaseUrl(), 'https://api.groq.com');
    assert.equal(normalizeGroqBaseUrl(''), 'https://api.groq.com');
  });

  it('strips /openai/v1 so SDK paths are not doubled', () => {
    assert.equal(
      normalizeGroqBaseUrl('https://api.groq.com/openai/v1'),
      'https://api.groq.com'
    );
    assert.equal(
      normalizeGroqBaseUrl('https://api.groq.com/openai/v1/'),
      'https://api.groq.com'
    );
  });

  it('leaves host-only URLs unchanged', () => {
    assert.equal(normalizeGroqBaseUrl('https://api.groq.com'), 'https://api.groq.com');
  });

  it('strips suffix on custom proxies', () => {
    assert.equal(
      normalizeGroqBaseUrl('https://proxy.example.com/openai/v1'),
      'https://proxy.example.com'
    );
  });
});
