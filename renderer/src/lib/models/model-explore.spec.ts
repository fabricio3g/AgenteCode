import { describe, expect, it } from 'vitest';
import { compactCount, quantFromFilename, relativeDate, repoSummaryLine } from './model-explore';

describe('relativeDate', () => {
  const now = new Date(2026, 8, 9, 12).getTime();
  it('labels today and yesterday', () => {
    expect(relativeDate(new Date(2026, 8, 9, 8).toISOString(), now)).toBe('Today');
    expect(relativeDate(new Date(2026, 8, 8, 20).toISOString(), now)).toBe('Yesterday');
  });
  it('counts days then falls back to month day', () => {
    expect(relativeDate(new Date(2026, 7, 20).toISOString(), now)).toBe('20 days ago');
    // Month-day shape is locale dependent; assert date parts only.
    expect(relativeDate(new Date(2026, 5, 3).toISOString(), now)).toMatch(/3/);
  });
  it('returns empty for missing or invalid input', () => {
    expect(relativeDate(undefined, now)).toBe('');
    expect(relativeDate('nope', now)).toBe('');
  });
});

describe('repoSummaryLine', () => {
  it('combines size, file count and largest artifact', () => {
    expect(
      repoSummaryLine({
        repo_id: 'x/y',
        size_label: '4B',
        gguf_files: [{ size_human: '2.8 GB' }, { size_human: '1 GB' }],
        largest_gguf_human: '2.8 GB'
      })
    ).toBe('4B · 2 GGUF files · largest 2.8 GB');
  });
  it('falls back gracefully', () => {
    expect(repoSummaryLine({ repo_id: 'x/y' })).toBe('');
  });
});

describe('quantFromFilename', () => {
  it('parses common quant tags', () => {
    expect(quantFromFilename('Qwen3.5-4B-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantFromFilename('model-q8_0.gguf')).toBe('Q8_0');
    expect(quantFromFilename('model.gguf')).toBe('');
  });
});

describe('compactCount', () => {
  it('compacts thousands and millions', () => {
    expect(compactCount(872724)).toBe('872.7K');
    expect(compactCount(102)).toBe('102');
    expect(compactCount(undefined)).toBe('0');
  });
});
