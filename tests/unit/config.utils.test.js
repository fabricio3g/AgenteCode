/**
 * Unit tests for config utility functions.
 * Run with: node --test tests/unit/config.utils.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { slugify, deepMerge, deepClone } from '../../main/config.utils.ts';

// ── slugify tests ──────────────────────────────────────────────────────────

describe('slugify', () => {
  it('converts spaces to hyphens', () => {
    assert.strictEqual(slugify('Hello World'), 'hello-world');
  });

  it('removes special characters', () => {
    assert.strictEqual(slugify('My Model Name!'), 'my-model-name');
    assert.strictEqual(slugify('Test@#$Model'), 'test-model');
  });

  it('handles multiple consecutive spaces', () => {
    assert.strictEqual(slugify('Multiple   Spaces'), 'multiple-spaces');
  });

  it('converts to lowercase', () => {
    assert.strictEqual(slugify('UPPERCASE'), 'uppercase');
    assert.strictEqual(slugify('MixedCase'), 'mixedcase');
  });

  it('removes leading and trailing hyphens', () => {
    assert.strictEqual(slugify('-leading'), 'leading');
    assert.strictEqual(slugify('trailing-'), 'trailing');
    assert.strictEqual(slugify('-both-'), 'both');
  });

  it('returns "model" for empty string', () => {
    assert.strictEqual(slugify(''), 'model');
    assert.strictEqual(slugify('   '), 'model');
  });

  it('returns "model" for null/undefined', () => {
    assert.strictEqual(slugify(null), 'model');
    assert.strictEqual(slugify(undefined), 'model');
  });

  it('preserves numbers', () => {
    assert.strictEqual(slugify('Model 123'), 'model-123');
    assert.strictEqual(slugify('v2.0-alpha'), 'v2-0-alpha');
  });

  it('handles unicode characters', () => {
    assert.strictEqual(slugify('日本語モデル'), 'model'); // non-ASCII stripped
    assert.strictEqual(slugify('café-model'), 'caf-model'); // é is non-ASCII
  });
});

// ── deepMerge tests ────────────────────────────────────────────────────────

describe('deepMerge', () => {
  it('merges nested objects', () => {
    const target = { a: 1, b: { c: 2 } };
    const source = { b: { d: 3 } };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result, { a: 1, b: { c: 2, d: 3 } });
  });

  it('replaces arrays entirely', () => {
    const target = { arr: [1, 2, 3] };
    const source = { arr: [4, 5] };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result, { arr: [4, 5] });
  });

  it('replaces primitive values', () => {
    const target = { a: 1, b: 'old' };
    const source = { a: 2, b: 'new' };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result, { a: 2, b: 'new' });
  });

  it('handles null source', () => {
    const target = { a: 1 };
    const result = deepMerge(target, null);
    assert.deepStrictEqual(result, { a: 1 });
  });

  it('handles undefined source', () => {
    const target = { a: 1 };
    const result = deepMerge(target, undefined);
    assert.deepStrictEqual(result, { a: 1 });
  });

  it('handles empty source', () => {
    const target = { a: 1 };
    const result = deepMerge(target, {});
    assert.deepStrictEqual(result, { a: 1 });
  });

  it('adds new keys from source', () => {
    const target = { a: 1 };
    const source = { b: 2 };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result, { a: 1, b: 2 });
  });

  it('handles deeply nested merge', () => {
    const target = { a: { b: { c: { d: 1 } } } };
    const source = { a: { b: { c: { e: 2 } } } };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result, { a: { b: { c: { d: 1, e: 2 } } } });
  });

  it('does not merge arrays as objects', () => {
    const target = { a: [1, 2] };
    const source = { a: [3] };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result, { a: [3] }); // replaced, not merged
  });

  it('handles null values in source', () => {
    const target = { a: 1, b: 2 };
    const source = { b: null };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result, { a: 1, b: null });
  });

  it('mutates target in place', () => {
    const target = { a: 1 };
    const source = { b: 2 };
    const result = deepMerge(target, source);
    assert.strictEqual(result, target); // same reference
  });

  it('handles complex real-world config merge', () => {
    const target = {
      llm: {
        provider: 'openai',
        providers: {
          openai: { model: 'gpt-4', api_key: '' }
        }
      }
    };
    const source = {
      llm: {
        provider: 'anthropic',
        providers: {
          openai: { model: 'gpt-4o' }
        }
      }
    };
    const result = deepMerge(target, source);
    assert.strictEqual(result.llm.provider, 'anthropic');
    assert.strictEqual(result.llm.providers.openai.model, 'gpt-4o');
    assert.strictEqual(result.llm.providers.openai.api_key, ''); // preserved
  });
});

// ── deepClone tests ────────────────────────────────────────────────────────

describe('deepClone', () => {
  it('clones simple objects', () => {
    const original = { a: 1, b: 'test' };
    const clone = deepClone(original);
    assert.deepStrictEqual(clone, original);
    assert.notStrictEqual(clone, original);
  });

  it('clones nested objects', () => {
    const original = { a: { b: { c: 1 } } };
    const clone = deepClone(original);
    assert.deepStrictEqual(clone, original);
    assert.notStrictEqual(clone.a, original.a);
    assert.notStrictEqual(clone.a.b, original.a.b);
  });

  it('clones arrays', () => {
    const original = { arr: [1, 2, 3] };
    const clone = deepClone(original);
    assert.deepStrictEqual(clone, original);
    assert.notStrictEqual(clone.arr, original.arr);
  });

  it('handles circular references - structuredClone may throw or copy', () => {
    // Note: structuredClone behavior varies by Node version
    // Some versions throw, some handle it gracefully
    const obj = { a: 1 };
    obj.self = obj;
    // Either it throws (error) or succeeds (returns clone with same structure)
    // We just verify it doesn't hang indefinitely
    try {
      const clone = deepClone(obj);
      // If it succeeded, verify the clone has the expected structure
      assert.strictEqual(clone.a, 1);
    } catch (e) {
      // If it threw, that's also acceptable behavior
      assert.ok(e instanceof Error);
    }
  });
});

// ── Edge cases and real-world scenarios ─────────────────────────────────────

describe('real-world config scenarios', () => {
  it('slugify handles model IDs from catalogs', () => {
    assert.strictEqual(slugify('Qwen 3.5 2B Q4_K_M'), 'qwen-3-5-2b-q4-k-m');
    assert.strictEqual(slugify('Kitten Nano EN v0.2'), 'kitten-nano-en-v0-2');
  });

  it('deepMerge preserves missing default config keys', () => {
    const defaultConfig = {
      tts: { engine: 'kokoro', num_threads: 2 },
      llm: { provider: 'openai', providers: {} },
      rag: { enabled: true }
    };
    const userConfig = {
      llm: { provider: 'anthropic' }
    };
    const result = deepMerge(structuredClone(defaultConfig), userConfig);
    // Preserved from default
    assert.strictEqual(result.tts.engine, 'kokoro');
    assert.strictEqual(result.tts.num_threads, 2);
    assert.strictEqual(result.rag.enabled, true);
    // Overridden by user
    assert.strictEqual(result.llm.provider, 'anthropic');
  });
});