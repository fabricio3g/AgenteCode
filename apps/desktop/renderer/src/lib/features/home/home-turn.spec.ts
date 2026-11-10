import { describe, expect, it, vi } from 'vitest';
import type { AgentStep, ChatMessage } from '$lib/types/chat';
import type { AgentTaskResult } from '$lib/services/agent-types';
import { applyHomeAgentResult, homeAgentCallbacks, planHomeAgentRun, settleAgentSteps } from './home-turn';
import { finalizeAssistantMetadata } from '$lib/stores/app-store-helpers';
import { emptySpend } from '$shared/accounting';
import { updateHomeLive, type HomeLiveState } from './home-live';
import { liveStatus } from '$lib/features/code/work-blocks';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    createdAt: 0,
    done: false,
    status: 'streaming',
    ...overrides
  } as ChatMessage;
}

function result(overrides: Partial<AgentTaskResult> = {}): AgentTaskResult {
  return {
    content: 'Answer.',
    reasoning: '',
    steps: [],
    artifact: null,
    artifacts: [],
    sources: [],
    outcome: 'completed',
    stopReason: 'none',
    ...overrides
  };
}

const ctx = { modelName: 'm', backendMode: 'api' as const, requestedProvider: 'aggregator' };

describe('planHomeAgentRun', () => {
  it('plain agent turns use the chat profile and budget', () => {
    const plan = planHomeAgentRun({ composerMode: 'agent', searchMode: 'chat' });
    expect(plan).toMatchObject({ instant: false, agentProfile: 'chat', toolMode: 'agent', searchMode: undefined });
    expect(plan.budget.maxIterations).toBe(12);
  });

  it('research depth picks the search profile and its own budget', () => {
    const deep = planHomeAgentRun({ composerMode: 'agent', searchMode: 'deep' });
    expect(deep).toMatchObject({ agentProfile: 'search', toolMode: 'search_chat', searchMode: 'deep' });
    expect(deep.budget.maxToolCalls).toBe(90);
    expect(planHomeAgentRun({ composerMode: 'agent', searchMode: 'max' }).budget.maxIterations).toBe(48);
  });

  it('Instant keeps its fast path whatever the depth', () => {
    const plan = planHomeAgentRun({ composerMode: 'instant', searchMode: 'deep' });
    expect(plan).toMatchObject({ instant: true, toolMode: 'instant' });
    expect(plan.budget.maxIterations).toBe(4);
  });
});

describe('applyHomeAgentResult', () => {
  it('keeps thoughts on either side of a tool call in the shared timeline', () => {
    const target = message();
    const callbacks = homeAgentCallbacks({ message: target, quiet: false, sync: vi.fn(), persist: vi.fn(), onReasoningStart: vi.fn(), onArtifacts: vi.fn(), touch: vi.fn() });
    callbacks.onReasoning?.('First thought.');
    const step = { id: 'search', type: 'tool', label: 'Search', toolName: 'web_search', status: 'running' } as const;
    callbacks.onStep([step]);
    callbacks.onStep([{ ...step, status: 'done' }]);
    callbacks.onReasoning?.('First thought.Second thought.');
    expect(target.metadata?.codeTimeline).toEqual([
      { kind: 'thinking', text: 'First thought.' },
      { kind: 'step', id: 'search' },
      { kind: 'thinking', text: 'Second thought.' }
    ]);
  });

  it('keeps live accounting and stream speed through finalization', () => {
    const target = message();
    const callbacks = homeAgentCallbacks({ message: target, quiet: false, sync: vi.fn(), persist: vi.fn(), onReasoningStart: vi.fn(), onArtifacts: vi.fn(), touch: vi.fn() });
    const usage = { prompt_tokens: 1000, completion_tokens: 100, timings: { output_stream_ms: 1000 } };
    const spend = { ...emptySpend(), costUsd: 0.012, promptTokens: 1000 };
    callbacks.onSpend?.(spend);
    callbacks.onUsage?.(usage);
    expect(target.metadata).toMatchObject({ codeSpend: spend, tokensPerSecond: 99 });
    applyHomeAgentResult(target, result({ usage, spend }), ctx);
    target.metadata = finalizeAssistantMetadata({ existing: target.metadata, modelName: 'm', backendMode: 'api', usage });
    expect(target.metadata).toMatchObject({ codeSpend: spend, tokensPerSecond: 99 });
  });
  it('a failure with nothing usable becomes an error with friendly text', () => {
    const target = message();
    applyHomeAgentResult(target, result({ content: '', outcome: 'failed', error: 'boom' }), ctx);
    expect(target.status).toBe('error');
    expect(target.content).toBeTruthy();
    expect(target.metadata).toMatchObject({ error: true, currentActivity: 'stopped', activityLabel: 'Agent failed' });
  });

  it('a stopped run keeps its content and carries a warning', () => {
    const target = message();
    applyHomeAgentResult(target, result({ outcome: 'stopped', stopReason: 'timeout' }), ctx);
    expect(target.status).toBe('idle');
    expect(target.content).toBe('Answer.');
    expect(target.metadata?.warning).toBeTruthy();
    expect(target.metadata).toMatchObject({ outcome: 'stopped', stopReason: 'timeout', activityLabel: 'Stopped' });
  });

  it('merges sources without duplicates and marks the turn as searched', () => {
    const target = message({ sources: [{ title: 'A', url: 'https://a' }] as never, searchMode: 'chat' });
    applyHomeAgentResult(target, result({
      sources: [{ title: 'A', url: 'https://a' }, { title: 'B', url: 'https://b' }] as never
    }), ctx);
    expect(target.sources?.map((source) => source.url)).toEqual(['https://a', 'https://b']);
    expect(target.searchMode).toBe('search');
    expect(target.searchMeta).toMatchObject({ searchSucceeded: true, sourceCount: 2 });
  });

  it('a research turn with no sources records the failed search', () => {
    const target = message();
    applyHomeAgentResult(target, result({ error: 'no results', outcome: 'partial' }), { ...ctx, searchMode: 'deep' });
    expect(target.searchMeta).toMatchObject({ searchRequested: true, searchSucceeded: false, searchError: 'no results' });
  });

  it('keeps live diff steps the final list dropped', () => {
    const diff = { id: 'edit', label: 'Edit', status: 'done', diffStats: [{ path: 'a', kind: 'modify', additions: 1, deletions: 0 }] } as unknown as AgentStep;
    const target = message({ agentSteps: [diff] });
    applyHomeAgentResult(target, result({ steps: [{ id: 's1', label: 'Search', status: 'done' } as AgentStep] }), ctx);
    expect(target.agentSteps?.map((step) => step.id)).toEqual(['s1', 'edit']);
  });
});

it('uses the Code status rules for runtime progress and approvals', () => {
  const state: HomeLiveState = {};
  const status = (approval = false) => liveStatus({ ...state, steps: [], timeline: [] }, approval);
  updateHomeLive(state, { type: 'thinking' });
  expect(status()).toEqual({ kind: 'requesting' });
  updateHomeLive(state, { type: 'generation_progress', output_bytes: 100, tool_name: 'design_write' });
  updateHomeLive(state, { type: 'generation_progress', output_bytes: 200, tool_name: 'design_write' });
  expect(status()).toEqual({ kind: 'preparing', toolName: 'design_write', bytes: 100 });
  expect(status(true)).toEqual({ kind: 'approval' });
  updateHomeLive(state, { type: 'assistant_delta', text: 'Done' });
  expect(status()).toEqual({ kind: 'writing' });
});

describe('settleAgentSteps', () => {
  const steps = [
    { id: 'a', label: 'A', status: 'running' },
    { id: 'b', label: 'B', status: 'running', detail: 'working' }
  ] as AgentStep[];

  it('marks the run done and the last step ready on completion', () => {
    const settled = settleAgentSteps(steps, { outcome: 'completed' });
    expect(settled.map((step) => step.status)).toEqual(['done', 'done']);
    expect(settled[1].detail).toBe('Response ready');
  });

  it('surfaces an error or a warning on the last step', () => {
    expect(settleAgentSteps(steps, { error: true })[1].status).toBe('error');
    expect(settleAgentSteps(steps, { warning: 'Out of time' })[1].detail).toBe('Out of time');
  });
});
