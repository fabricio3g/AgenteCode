import { describe, expect, it } from 'vitest';
import { injectEvidenceSummary, trimContext } from '$lib/services/agent-message-context';
import { compactText } from '$lib/services/agent-evidence';
import type { RequestMessage } from '$lib/services/chat-api';

describe('agent-message-context', () => {
  it('trimContext preserves the first and latest user requests', () => {
    const messages: RequestMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'middle request' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'latest request' },
      { role: 'assistant', content: 'a3' },
      { role: 'tool', content: 'tool-result', tool_call_id: 't1', name: 'web_search' }
    ];

    trimContext(messages, 3);

    const userContents = messages.filter((message) => message.role === 'user').map((message) => message.content);
    expect(userContents).toContain('first request');
    expect(userContents).toContain('latest request');
  });

  it('injectEvidenceSummary replaces prior injected summaries', () => {
    const messages: RequestMessage[] = [
      { role: 'system', content: 'base system' },
      { role: 'system', content: '=== EVIDENCE SUMMARY ===\nold\n=== END EVIDENCE ===' }
    ];

    injectEvidenceSummary(
      messages,
      [{ name: 'web_search', args: {}, success: true, summary: 'Found one result' }],
      [{ title: 'Example', url: 'https://example.com', snippet: 'Snippet' }],
      compactText
    );

    const summaries = messages.filter((message) => typeof message.content === 'string' && message.content.includes('=== EVIDENCE SUMMARY ==='));
    expect(summaries).toHaveLength(1);
    expect(String(summaries[0].content)).toContain('Found one result');
    expect(String(summaries[0].content)).toContain('Example');
  });

  it('injectEvidenceSummary can preserve longer source text for research synthesis', () => {
    const messages: RequestMessage[] = [{ role: 'system', content: 'base system' }];
    const longSourceText = `Specific source detail ${'with important evidence '.repeat(40)}`;

    injectEvidenceSummary(
      messages,
      [{ name: 'fetch_url', args: {}, success: true, summary: longSourceText }],
      [{ title: 'Research Source', url: 'https://example.com/source', snippet: 'short snippet', full_content: longSourceText }],
      compactText,
      {
        observationLimit: 2,
        observationChars: 900,
        sourceLimit: 2,
        sourceChars: 900,
        instruction: 'Use this detailed research evidence.'
      }
    );

    const summary = String(messages.find((message) => typeof message.content === 'string' && message.content.includes('=== EVIDENCE SUMMARY ==='))?.content || '');
    expect(summary).toContain('Use this detailed research evidence.');
    expect(summary).toContain('https://example.com/source');
    expect(summary).toContain('Specific source detail with important evidence');
    expect(summary.length).toBeGreaterThan(900);
  });
});
