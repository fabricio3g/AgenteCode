import { describe, expect, it } from 'vitest';
import {
  hasToolIntent,
  parseXmlToolCall,
  isPublicFallbackContent,
  parseDegradedXmlToolCalls,
  stripToolCallArtifacts
} from '$lib/services/agent-parsing';

describe('agent-parsing', () => {
  it('reads the attribute-style map call reported in Home', () => {
    const call = `<tool_call id="1" label="maps" parameters='{"center": "Buenos Aires, Argentina", "zoom": 12, "size": "800x600", "maptype": "roadmap"}'></tool_call>`;
    expect(parseXmlToolCall(call).toolCall).toEqual({ name: 'maps', arguments: { center: 'Buenos Aires, Argentina', zoom: 12, size: '800x600', maptype: 'roadmap' } });
    expect(stripToolCallArtifacts(call)).toBe('');
  });

  it('keeps normal JSON-body calls and surrounding prose', () => {
    const call = '<tool_call>{"name":"create_map","arguments":{"place":"Madrid"}}</tool_call>';
    expect(parseXmlToolCall(`Before ${call} After`)).toEqual({ toolCall: { name: 'create_map', arguments: { place: 'Madrid' } }, cleanContent: 'Before  After' });
  });

  it('hides partial and self-closing calls without losing the answer', () => {
    for (const tag of ['<tool', '<tool_call', '<tool_call>{"name":', `<tool_call label="maps" parameters='{"center":"A > B"}'/>`]) {
      expect(stripToolCallArtifacts(`Checking. ${tag}`)).toBe('Checking.');
    }
    expect(stripToolCallArtifacts('A < B and C > D')).toBe('A < B and C > D');
  });

  it('does not execute malformed attribute arguments', () => {
    expect(parseXmlToolCall(`<tool_call label="maps" parameters='not json'></tool_call>`).toolCall).toBeNull();
    expect(parseXmlToolCall(`<tool_call label="maps" parameters='[]'/>`).toolCall).toBeNull();
  });
  it('recognizes evidence-only fallback content without visible stop boilerplate', () => {
    expect(isPublicFallbackContent('## Gathered Evidence\n\n- Source-backed fact [1]')).toBe(true);
    expect(isPublicFallbackContent('No reliable gathered evidence was available.')).toBe(true);
    expect(isPublicFallbackContent('Here is a normal completed answer.')).toBe(false);
  });

  it('recognizes partial research reports as public fallback content', () => {
    const partial = [
      '# Clinical research overview',
      '',
      '_Partial research report from retrieved sources (automatic synthesis). Say **continue** to deepen or refine._',
      '',
      '## Key findings',
      '',
      'First-line therapy is selected by severity and comorbidities. [1]'
    ].join('\n');
    expect(isPublicFallbackContent(partial)).toBe(true);
    expect(isPublicFallbackContent('# Full report\n\n## Key findings\n\nComplete synthesis.')).toBe(false);
  });

  it('recognizes human-readable partial answers as public fallback content', () => {
    expect(
      isPublicFallbackContent(
        '# Topic\n\nPartial answer from sources already retrieved. Say **continue** if you want more depth.\n\nSome prose.'
      )
    ).toBe(true);
    expect(
      isPublicFallbackContent(
        'Battery storage helps. I could not complete every step, so this is based only on what was already found.'
      )
    ).toBe(true);
    expect(
      isPublicFallbackContent(
        'I stopped before finishing and did not gather enough information to answer fully. Please try again or rephrase your request.'
      )
    ).toBe(true);
  });
});

describe('degraded tagless tool calls', () => {
  // Exact shape from the MiniCPM Home-agent report: the model drops the
  // `<tool_call>` wrapper and emits bare `name="…">` fragments.
  const degraded = [
    'I need to search the web for the latest information about the best LLMs in 2026.',
    'name="web_search"> name="query">best LLM 2026 investigate',
    'name="web_search"> name="query">LLM 2026 capabilities comparison',
    'name="web_search"> name="query">best language model 2026 features'
  ].join('\n');

  it('recovers one tool call per fragment line with its arguments', () => {
    const { toolCalls, cleanContent } = parseDegradedXmlToolCalls(degraded);
    expect(toolCalls).toHaveLength(3);
    expect(toolCalls[0]).toEqual({ name: 'web_search', arguments: { query: 'best LLM 2026 investigate' } });
    expect(toolCalls[2]).toEqual({ name: 'web_search', arguments: { query: 'best language model 2026 features' } });
    expect(cleanContent).not.toContain('name="web_search"');
    expect(cleanContent).toContain('best LLMs in 2026');
  });

  it('ignores prose that merely mentions a name attribute', () => {
    expect(parseDegradedXmlToolCalls('Set name="answer" to the final value.').toolCalls).toHaveLength(0);
    expect(parseDegradedXmlToolCalls('Here is a normal completed answer.').toolCalls).toHaveLength(0);
  });

  it('detects tool intent in planning sentences and fragments', () => {
    expect(hasToolIntent(degraded)).toBe(true);
    expect(hasToolIntent("I'll use the web_search tool to find relevant articles.")).toBe(true);
    expect(hasToolIntent('Let me use the fetch_url tool to read the page.')).toBe(true);
    expect(hasToolIntent('Here is a normal completed answer.')).toBe(false);
    expect(hasToolIntent('')).toBe(false);
  });

  it('strips tagless fragments from visible text', () => {
    const stripped = stripToolCallArtifacts(degraded);
    expect(stripped).not.toContain('name="web_search"');
    expect(stripped).toContain('best LLMs in 2026');
  });
});
