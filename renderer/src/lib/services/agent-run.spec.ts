/**
 * End-to-end behaviour of the Home agent run (runAgentTask) against a scripted
 * model: the transport fallbacks, the stop guards, research gathering and the
 * forced final answer. The model is the only fake; the loop, tools and
 * fallbacks are real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/storage', () => ({ loadAppConfig: vi.fn(async () => ({ llm: { backend_mode: 'api', provider: 'gemini', providers: { gemini: { model: 'gemini-3-flash', base_url: 'https://example.test' } } } })) }));
vi.mock('$lib/services/bridge', () => ({ isElectron: () => true, invoke: vi.fn(), listen: vi.fn() }));
vi.mock('$lib/services/agent-token-budget', () => ({ enforceTokenBudget: vi.fn(async () => {}) }));
vi.mock('$lib/services/agent-llm', () => ({ supportsNativeTools: vi.fn(() => true), agentComplete: vi.fn(), agentStreamComplete: vi.fn() }));
vi.mock('$lib/services/search', () => ({ webSearch: vi.fn(), fetchUrlContent: vi.fn() }));
vi.mock('$lib/services/chat-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/services/chat-api')>()),
  completeAssistantReply: vi.fn(),
  setToolSupportCache: vi.fn()
}));

import { agentStreamComplete, supportsNativeTools } from './agent-llm';
import { webSearch } from './search';
import { completeAssistantReply } from './chat-api';
import { runAgentTask } from './agent';
import type { RunAgentTaskArgs } from './agent-types';

const stream = vi.mocked(agentStreamComplete);

function run(prompt: string, extra: Partial<RunAgentTaskArgs> = {}) {
  return runAgentTask({
    chatId: 'run-spec',
    rawPrompt: prompt,
    messages: [{ role: 'user', content: prompt }],
    agentProfile: 'chat',
    onStep: vi.fn(),
    onArtifact: vi.fn(),
    ...extra
  });
}

function toolTurn(name: string, args: Record<string, unknown>, id = `${name}-${Math.random().toString(36).slice(2, 6)}`) {
  return { content: '', reasoning: '', toolCalls: [{ id, name, arguments: args }] };
}

describe('runAgentTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stream.mockReset();
    vi.mocked(supportsNativeTools).mockReturnValue(true);
    vi.mocked(completeAssistantReply).mockReset();
  });

  it('falls back to XML when the provider rejects native tools', async () => {
    const tools: unknown[] = [];
    stream
      .mockImplementationOnce(async (args) => {
        tools.push(args.tools);
        throw new Error('HTTP 400: tools are not supported for this model');
      })
      .mockImplementationOnce(async (args) => {
        tools.push(args.tools);
        return { content: 'Plain answer.', reasoning: '' };
      });
    const result = await run('What is the capital of France?');
    expect(result.content).toBe('Plain answer.');
    expect(result.outcome).toBe('completed');
    expect(tools[0]).toBeDefined();
    expect(tools[1]).toBeUndefined();
  });

  it('stops the run on a non-recoverable model error', async () => {
    stream.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await run('Hello there');
    // The strict fallback text counts as a usable result, so this reports as
    // stopped-with-warning rather than failed.
    expect(result.outcome).toBe('stopped');
    expect(result.warning).toBeTruthy();
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('switches to direct mode after two empty replies', async () => {
    stream
      .mockResolvedValueOnce({ content: '', reasoning: '' })
      .mockResolvedValueOnce({ content: '', reasoning: '' })
      .mockResolvedValueOnce({ content: 'Direct answer.', reasoning: '' });
    const result = await run('Tell me something');
    expect(result.content).toBe('Direct answer.');
    expect(stream).toHaveBeenCalledTimes(3);
    // Direct mode sends no tools.
    expect(stream.mock.calls[2][0].tools).toBeUndefined();
  });

  it('stops a stalled loop of identical failing calls', async () => {
    stream.mockImplementation(async () => toolTurn('calculator', { expression: '((' }));
    const result = await run('Compute something', { maxIterations: 10, maxToolCalls: 40 });
    expect(result.stopReason).toBe('loop');
    expect(result.warning).toBeTruthy();
    expect(stream.mock.calls.length).toBeLessThan(10);
  });

  it('ends at the tool budget with an evidence-only answer', async () => {
    let n = 0;
    stream.mockImplementation(async () => toolTurn('calculator', { expression: `${++n}+1` }));
    const result = await run('Add some numbers', { maxIterations: 6, maxToolCalls: 6 });
    expect(result.stopReason).toBe('tool_limit');
    expect(result.warning).toMatch(/tool call limit/i);
    expect(result.content).toBeTruthy();
    expect(completeAssistantReply).not.toHaveBeenCalled();
  });

  it('forces a final answer when the step limit runs out', async () => {
    let n = 0;
    stream.mockImplementation(async () => toolTurn('calculator', { expression: `${++n}*2` }));
    vi.mocked(completeAssistantReply).mockResolvedValueOnce({ content: 'Final summary.', reasoning: '' } as never);
    const result = await run('Multiply things', { maxIterations: 2, maxToolCalls: 20 });
    expect(result.content).toBe('Final summary.');
    expect(result.stopReason).toBe('iteration_limit');
    expect(result.outcome).toBe('partial');
    // The forced request must never carry unanswered tool calls.
    const forced = vi.mocked(completeAssistantReply).mock.calls[0][0].messages;
    const lastToolCalls = forced.filter((m) => m.tool_calls?.length).at(-1);
    const answered = forced.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    for (const call of lastToolCalls?.tool_calls || []) expect(answered).toContain(call.id);
  });

  it('research runs start from a system search and finish as a sourced report', async () => {
    vi.mocked(webSearch).mockResolvedValueOnce({
      results: [1, 2, 3, 4, 5, 6].map((i) => ({
        title: `Source ${i}`,
        url: `https://example.test/${i}`,
        snippet: 'Solar capacity grew strongly last year according to the agency report. '.repeat(3),
        full_content: 'Solar capacity grew strongly last year. '.repeat(40)
      }))
    } as never);
    stream.mockResolvedValueOnce({ content: '# Solar growth\n\nCapacity grew strongly (Source 1, 2024).', reasoning: '' });
    const onSources = vi.fn();
    const onStep = vi.fn();
    const result = await run('How fast did solar capacity grow?', {
      agentProfile: 'search',
      toolMode: 'search_chat',
      searchMode: 'search',
      onSources,
      onStep
    });
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(onSources).toHaveBeenCalled();
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.content).toContain('Solar growth');
    expect(result.stopReason).toBe('none');
    expect(result.outcome).toBe('completed');
    const firstSteps = onStep.mock.calls[0][0];
    expect(firstSteps[0]).toMatchObject({ type: 'searching', label: 'Searching' });
  });

  it('Instant sends only the allowlisted tools', async () => {
    stream.mockResolvedValueOnce({ content: 'Quick answer.', reasoning: '' });
    await run('Quick question', { toolMode: 'instant' });
    const names = (stream.mock.calls[0][0].tools || []).map((tool) => tool.function.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => ['web_search', 'fetch_url', 'query_knowledge', 'calculator', 'get_weather', 'convert_currency', 'get_quote'].includes(name))).toBe(true);
  });
});
