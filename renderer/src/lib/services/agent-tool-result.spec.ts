import { describe, expect, it, vi } from 'vitest';
import type { AgentStep } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';
import {
  appendToolResultMessage,
  createRunningToolStep,
  finalizeToolStep,
  mergeWebSearchSources,
  recoverOptionalPresentationFailure
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

  it('upgrades existing sources when fetch_url returns deeper content', () => {
    const sources = [{ title: 'Existing', url: 'https://a.test', snippet: 'short', full_content: '' }];
    const seenUrls = new Set(['https://a.test']);
    const onSources = vi.fn();

    mergeWebSearchSources({
      toolCall: { name: 'fetch_url', arguments: { url: 'https://a.test' } },
      result: {
        success: true,
        output: {
          url: 'https://a.test',
          title: 'Existing article',
          excerpt: 'short lead',
          content: 'A much longer body of page text used for research synthesis.'.repeat(3),
          quality: 'ok'
        }
      },
      sources,
      seenUrls,
      onSources
    });

    expect(sources).toHaveLength(1);
    expect(sources[0].full_content?.length || 0).toBeGreaterThan(40);
    expect(sources[0].title).toBe('Existing article');
    expect(onSources).toHaveBeenCalledOnce();
  });

  it('finalizeToolStep keeps fetch_url and web_search outputs short', () => {
    const fetchStep: AgentStep = createRunningToolStep(
      { name: 'fetch_url', arguments: { url: 'https://example.com/page' } },
      { fetch_url: 'reading' },
      () => 'step-1'
    );

    finalizeToolStep(fetchStep, {
      success: true,
      output: {
        url: 'https://example.com/page',
        title: 'Example',
        excerpt: 'Body',
        content: 'Huge content '.repeat(200),
        quality: 'ok'
      }
    }, 'fetch_url');

    expect(fetchStep.status).toBe('done');
    expect(fetchStep.output).toMatch(/Example/);
    expect(fetchStep.output).not.toContain('Huge content');
    expect(fetchStep.output?.length || 0).toBeLessThan(240);

    const searchStep: AgentStep = createRunningToolStep(
      { name: 'web_search', arguments: { query: 'climate policy 2024' } },
      { web_search: 'searching' },
      () => 'step-2'
    );

    finalizeToolStep(searchStep, {
      success: true,
      output: {
        query: 'climate policy 2024',
        mode: 'deep',
        context: 'Search performed at: …\n'.repeat(40),
        next_step: 'fetch more',
        results: [
          { title: 'First hit', url: 'https://a.test', snippet: 's' },
          { title: 'Second', url: 'https://b.test', snippet: 's' }
        ]
      }
    }, 'web_search');

    expect(searchStep.status).toBe('done');
    expect(searchStep.output).toMatch(/2 results/);
    expect(searchStep.output).not.toContain('Search performed at');
    expect(searchStep.output).not.toContain('next_step');
  });

  it('presents optional skipped tools as completed guidance instead of failures', () => {
    const step: AgentStep = createRunningToolStep(
      { name: 'create_info_card', arguments: { title: 'Empty', rows: [] } },
      { create_info_card: 'writing' },
      () => 'step-2'
    );

    finalizeToolStep(step, {
      success: true,
      output: {
        created: false,
        skipped: true,
        reason: 'No evidence-backed label/value rows were provided.'
      }
    });

    expect(step.status).toBe('done');
    expect(step.detail).toBe('Skipped — No evidence-backed label/value rows were provided.');
    expect(step.output).not.toContain('Failed');
  });

  it('recovers validation failures for optional visuals but preserves real failures', () => {
    const validation = recoverOptionalPresentationFailure(
      { name: 'create_dashboard', arguments: { metrics: [] } },
      { success: false, error: 'Dashboard requires at least one metric.' }
    );
    expect(validation).toMatchObject({
      success: true,
      output: { created: false, skipped: true }
    });

    const runtime = { success: false, error: 'Permission denied while writing output.' };
    expect(recoverOptionalPresentationFailure(
      { name: 'create_chart', arguments: {} },
      runtime
    )).toBe(runtime);

    const search = { success: false, error: 'Search requires a query.' };
    expect(recoverOptionalPresentationFailure(
      { name: 'web_search', arguments: {} },
      search
    )).toBe(search);
  });
});
