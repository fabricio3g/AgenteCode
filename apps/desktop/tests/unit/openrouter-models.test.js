import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelMetadataRecord } from '../../main/providers/openai-core.ts';

describe('model catalog metadata parsing', () => {
  it('maps OpenRouter REST list records (snake_case + top_provider)', () => {
    const meta = parseModelMetadataRecord({
      id: 'google/gemma-4-31b-it:free',
      context_length: 128000,
      top_provider: { max_completion_tokens: 8192 },
      pricing: { prompt: '0.0000015', completion: '0.000002' }
    });
    assert.deepEqual(meta, {
      context_window: 128000,
      max_completion_tokens: 8192,
      prompt_cost_per_million: 1.5,
      completion_cost_per_million: 2
    });
  });

  it('accepts camelCase and alternate field names', () => {
    const meta = parseModelMetadataRecord({
      id: 'x/y',
      inputTokenLimit: 32000,
      outputTokenLimit: 4096
    });
    assert.deepEqual(meta, {
      context_window: 32000,
      max_completion_tokens: 4096
    });
  });

  it('returns null without a positive context length', () => {
    assert.equal(parseModelMetadataRecord({ id: 'x' }), null);
    assert.equal(parseModelMetadataRecord(null), null);
  });
});
