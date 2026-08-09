import { describe, expect, it, vi } from 'vitest';
import { handleWebSearch } from '$lib/services/agent-tool-core';
import type { ToolContext } from '$lib/services/agent-types';

const baseCtx = {
  searchMode: 'deep',
  conversationContext: 'prior chat'
} as ToolContext;

describe('handleWebSearch', () => {
  it('returns compact structured results without duplicating full context', async () => {
    const webSearch = vi.fn(async () => ({
      results: [
        {
          title: 'Alpha',
          url: 'https://a.test',
          snippet: 'short',
          full_content: 'Deep body content that is long enough to keep. '.repeat(20),
          provider: 'aggregator'
        },
        {
          title: 'Beta',
          url: 'https://b.test',
          snippet: 'only serp',
          provider: 'aggregator'
        }
      ],
      context: 'Search performed at: now\n\nHuge duplicated context block\n'.repeat(30)
    }));

    const result = await handleWebSearch({
      args: { query: 'test query', mode: 'deep' },
      ctx: baseCtx,
      webSearch,
      ok: (output) => ({ success: true, output }),
      fail: (error) => ({ success: false, error }),
      failFromError: (err) => ({ success: false, error: String(err) })
    });

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.context).toBeUndefined();
    expect(output.query).toBe('test query');
    expect(output.mode).toBe('deep');
    const results = output.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0].full_content).toBeTruthy();
    expect(String(results[0].full_content).length).toBeLessThanOrEqual(1800);
    expect(results[1].full_content).toBeUndefined();
    expect(output.next_step).toMatch(/full_content/i);
  });
});
