import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractModelsFromOpenRouterListPage,
  metadataFromOpenRouterModel,
  parseOpenRouterModelId
} from '../../main/providers/openrouter.ts';

describe('OpenRouter list page extraction', () => {
  it('unwraps SDK GetModelsResponse result.data shape', () => {
    const page = {
      result: {
        data: [
          { id: 'google/gemma-4-31b-it:free', contextLength: 128000 },
          { id: 'openai/gpt-4o', contextLength: 128000 }
        ],
        totalCount: 2
      }
    };
    const models = extractModelsFromOpenRouterListPage(page);
    assert.equal(models.length, 2);
    assert.equal(models[0].id, 'google/gemma-4-31b-it:free');
  });

  it('accepts legacy top-level data array', () => {
    const page = { data: [{ id: 'x/y', contextLength: 8192 }] };
    assert.equal(extractModelsFromOpenRouterListPage(page).length, 1);
  });

  it('returns empty for unknown shapes', () => {
    assert.deepEqual(extractModelsFromOpenRouterListPage(null), []);
    assert.deepEqual(extractModelsFromOpenRouterListPage({ foo: 1 }), []);
  });
});

describe('OpenRouter model id + metadata', () => {
  it('parses author/slug including variant suffix', () => {
    assert.deepEqual(parseOpenRouterModelId('google/gemma-4-31b-it:free'), {
      author: 'google',
      slug: 'gemma-4-31b-it:free'
    });
    assert.equal(parseOpenRouterModelId('no-slash'), null);
  });

  it('maps contextLength to context_window', () => {
    const meta = metadataFromOpenRouterModel({
      id: 'google/gemma-4-31b-it:free',
      contextLength: 128000,
      topProvider: { maxCompletionTokens: 8192 }
    });
    assert.deepEqual(meta, {
      context_window: 128000,
      max_completion_tokens: 8192
    });
  });

  it('returns null without a positive context length', () => {
    assert.equal(metadataFromOpenRouterModel({ id: 'x' }), null);
    assert.equal(metadataFromOpenRouterModel(null), null);
  });
});
