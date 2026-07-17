import { describe, expect, it } from 'vitest';
import { ensureToolCallPairs, injectEvidenceSummary, trimContext } from '$lib/services/agent-message-context';
import { compactText } from '$lib/services/agent-evidence';
import type { RequestMessage } from '$lib/services/chat-api';
import { humanizeAgentError } from '$lib/utils/errors';

describe('agent-message-context', () => {
  it('legacy trimContext preserves the first and latest user requests', () => {
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

  it('history-preserving trim keeps all conversation turns while capping tool loop', () => {
    const history: RequestMessage[] = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'answer about alpha topic' },
      { role: 'user', content: 'middle request mentioning beta' },
      { role: 'assistant', content: 'answer about beta' },
      { role: 'user', content: 'latest request' }
    ];
    const tc = (id: string, name: string) => ({
      id,
      type: 'function' as const,
      function: { name, arguments: '{}' }
    });
    const loopGrowth: RequestMessage[] = [
      { role: 'assistant', content: 'calling tools', tool_calls: [tc('t1', 'web_search')] },
      { role: 'tool', content: 'tool-1', tool_call_id: 't1', name: 'web_search' },
      { role: 'assistant', content: 'calling more', tool_calls: [tc('t2', 'fetch_url')] },
      { role: 'tool', content: 'tool-2', tool_call_id: 't2', name: 'fetch_url' },
      { role: 'assistant', content: 'calling again', tool_calls: [tc('t3', 'web_search')] },
      { role: 'tool', content: 'tool-3', tool_call_id: 't3', name: 'web_search' },
      { role: 'assistant', content: 'still going', tool_calls: [tc('t4', 'fetch_url')] },
      { role: 'tool', content: 'tool-4', tool_call_id: 't4', name: 'fetch_url' },
      { role: 'assistant', content: 'yet more', tool_calls: [tc('t5', 'web_search')] },
      { role: 'tool', content: 'tool-5', tool_call_id: 't5', name: 'web_search' }
    ];

    const messages: RequestMessage[] = [
      { role: 'system', content: 'sys' },
      ...history,
      ...loopGrowth
    ];

    trimContext(messages, { historyCount: history.length, maxLoopMessages: 4 });

    const userContents = messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content);
    expect(userContents).toEqual(['first request', 'middle request mentioning beta', 'latest request']);

    // History assistant answers must remain
    const contents = messages.map((m) => m.content);
    expect(contents).toContain('answer about alpha topic');
    expect(contents).toContain('answer about beta');

    // Loop growth capped; tool pairs stay valid
    const nonSys = messages.filter((m) => m.role !== 'system');
    const loop = nonSys.slice(history.length);
    expect(loop.length).toBeLessThanOrEqual(6);
    expect(loop.length).toBeGreaterThanOrEqual(2);
    // Every tool message has a matching preceding tool_calls id
    for (let i = 0; i < loop.length; i++) {
      if (loop[i].role !== 'tool') continue;
      const id = loop[i].tool_call_id;
      const parent = [...loop.slice(0, i)].reverse().find((m) => m.role === 'assistant');
      expect(parent?.tool_calls?.some((c) => c.id === id)).toBe(true);
    }
  });

  it('history-preserving trim is a no-op when under budget for paired tools', () => {
    const messages: RequestMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      {
        role: 'assistant',
        content: 'a1',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'web_search', arguments: '{}' } }]
      },
      { role: 'tool', content: 't1', tool_call_id: '1', name: 'web_search' }
    ];
    const before = messages.map((m) => m.content);
    trimContext(messages, { historyCount: 2, maxLoopMessages: 8 });
    expect(messages.map((m) => m.content)).toEqual(before);
  });

  it('ensureToolCallPairs fills missing tool results', () => {
    const messages: RequestMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{}' } }
        ]
      },
      { role: 'tool', content: '{}', tool_call_id: 'call_1', name: 'get_weather' }
    ];
    ensureToolCallPairs(messages, 'fill');
    const toolIds = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(toolIds).toContain('call_1');
    expect(toolIds).toContain('call_2');
  });

  it('ensureToolCallPairs strip removes incomplete tool_calls', () => {
    const messages: RequestMessage[] = [
      {
        role: 'assistant',
        content: 'hi',
        tool_calls: [{ id: 'x', type: 'function', function: { name: 'get_weather', arguments: '{}' } }]
      }
    ];
    ensureToolCallPairs(messages, 'strip');
    expect(messages[0].tool_calls).toBeUndefined();
    expect(messages[0].content).toBe('hi');
  });

  it('humanizeAgentError hides tool_calls 400 dump', () => {
    const msg = humanizeAgentError(
      new Error("Error invoking remote method 'chat_complete': Error: 400 An assistant message with 'tool_calls' must be followed by tool messages")
    );
    expect(msg.toLowerCase()).not.toContain('invoking remote');
    expect(msg.toLowerCase()).toContain('try again');
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
