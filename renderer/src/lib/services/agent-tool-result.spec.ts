import { describe, expect, it, vi } from 'vitest';
import type { AgentStep } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';
import {
  appendToolResultMessage,
  createRunningToolStep,
  finalizeToolStep,
  mergeWebSearchSources
} from '$lib/services/agent-tool-result';

describe('agent-tool-result', () => {
  it('creates native tool messages when native mode is active', () => {
    const messages: RequestMessage[] = [];

    appendToolResultMessage({
      toolCall: { id: 'call_1', name: 'web_search', arguments: { query: 'abc' } },
      result: { success: true, output: { results: [] } },
      messages,
      nativeActive: true,
      nativeFailed: false,
      maxToolResultChars: 1000
    });

    expect(messages[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', name: 'web_search' });
  });

  it('still emits role=tool with generated id when native mode is unavailable', () => {
    // Prefer tool-role messages whenever an id exists/can be generated so
    // assistant tool_calls turns never become unpaired (OpenAI 400).
    const messages: RequestMessage[] = [];
    const toolCall: { name: string; arguments: { expression: string }; id?: string } = {
      name: 'calculator',
      arguments: { expression: '1+1' }
    };

    appendToolResultMessage({
      toolCall,
      result: { success: true, output: { result: 2 } },
      messages,
      nativeActive: false,
      nativeFailed: true,
      maxToolResultChars: 1000
    });

    expect(messages[0]?.role).toBe('tool');
    expect(messages[0]?.name).toBe('calculator');
    expect(messages[0]?.tool_call_id).toBeTruthy();
    expect(toolCall.id).toBeTruthy();
  });

  it('merges only new web search source urls', () => {
    const sources = [{ title: 'Existing', url: 'https://a.test', snippet: 'old' }];
    const seenUrls = new Set(['https://a.test']);
    const onSources = vi.fn();

    mergeWebSearchSources({
      toolCall: { name: 'web_search', arguments: { query: 'q' } },
      result: {
        success: true,
        output: {
          results: [
            { title: 'Existing', url: 'https://a.test', snippet: 'old' },
            { title: 'New', url: 'https://b.test', snippet: 'new' }
          ]
        }
      },
      sources,
      seenUrls,
      onSources
    });

    expect(sources).toHaveLength(2);
    expect(onSources).toHaveBeenCalledOnce();
  });

  it('finalizeToolStep formats successful string outputs', () => {
    const step: AgentStep = createRunningToolStep(
      { name: 'fetch_url', arguments: { url: 'https://example.com' } },
      { fetch_url: 'searching' },
      () => 'step-1'
    );

    finalizeToolStep(step, { success: true, output: { title: 'Example', excerpt: 'Body' } });

    expect(step.status).toBe('done');
    expect(step.output).toContain('title: Example');
    expect(step.output).toContain('excerpt: Body');
  });
});
