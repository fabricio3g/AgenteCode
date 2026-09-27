import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildLocalModelOption,
  buildLocalModelSecondaryText,
  buildLocalModelSummaryChips,
  formatContextLength,
  formatModelParameterCount,
  localModelMatchesSearch
} from '../../renderer/src/lib/utils/local-models.ts';

describe('local model helpers', () => {
  it('maps structured local metadata into a model option', () => {
    const option = buildLocalModelOption({
      id: 'qwen3-8b',
      name: 'Qwen3-8B-Q4_K_M.gguf',
      path: 'C:/models/Qwen3-8B-Q4_K_M.gguf',
      architecture: 'qwen2',
      context_length: 32768,
      parameter_count: 8_000_000_000,
      size_label: '4.7 GB',
      quantization_name: 'Q4_K_M',
      block_count: 36,
      chat_template_uses_tools: true
    }, true);

    assert.equal(option.source, 'local');
    assert.equal(option.details, 'qwen2 • Q4_K_M • 4.7 GB');
    assert.equal(option.architecture, 'qwen2');
    assert.equal(option.context_length, 32768);
    assert.equal(option.parameter_count, 8_000_000_000);
    assert.equal(option.quantization_name, 'Q4_K_M');
    assert.equal(option.chat_template_uses_tools, true);
    assert.equal(option.has_mmproj, true);
  });

  it('matches local model search against architecture and quantization metadata', () => {
    const model = {
      id: 'qwen3-8b',
      name: 'Qwen3-8B-Q4_K_M.gguf',
      architecture: 'qwen2',
      quantization_name: 'Q4_K_M',
      size_label: '4.7 GB',
      details: ''
    };

    assert.equal(localModelMatchesSearch(model, 'qwen2'), true);
    assert.equal(localModelMatchesSearch(model, 'q4_k'), true);
    assert.equal(localModelMatchesSearch(model, 'mistral'), false);
  });

  it('formats selector summary text and summary chips with graceful fallbacks', () => {
    assert.equal(buildLocalModelSecondaryText({
      architecture: 'llama',
      quantization_name: 'Q8_0',
      size_label: '8.1 GB',
      details: ''
    }), 'llama • Q8_0 • 8.1 GB');

    assert.equal(buildLocalModelSecondaryText({
      architecture: '',
      quantization_name: '',
      size_label: '',
      details: 'legacy details'
    }), 'legacy details');

    assert.deepEqual(buildLocalModelSummaryChips({
      architecture: 'llama',
      quantization_name: 'Q8_0',
      size_label: '8.1 GB',
      parameter_count: 7_600_000_000,
      context_length: 8192,
      chat_template_uses_tools: false,
      has_mmproj: false
    }), ['llama', 'Q8_0', '8.1 GB', '7.6B params', '8k ctx', 'No tool template']);
  });

  it('formats context and parameter labels consistently', () => {
    assert.equal(formatContextLength(4096), '4k');
    assert.equal(formatContextLength(6144), '6k');
    assert.equal(formatModelParameterCount(2_000_000_000), '2.0B params');
    assert.equal(formatModelParameterCount(0), '');
  });
});
