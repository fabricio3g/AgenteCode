import { describe, expect, it } from 'vitest';
import type { AgentStep } from '$lib/types/chat';
import type { CodeChild } from '$shared/agente-protocol';
import { childActivity, childElapsedMs, childFromStep, linkChildToStep, unlinkedChildren } from './subagent-row';

const step = (id: string, extra: Partial<AgentStep> = {}): AgentStep => ({ id, type: 'tool', label: 'Task', toolName: 'task', status: 'running', ...extra });
const child = (id: string, extra: Partial<CodeChild> = {}): CodeChild => ({
  id, kind: 'explore', description: 'Map the transcript', status: 'running', text: '', tools: [], spend: { costUsd: 0, estimated: false, unpriced: true, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, ...extra
});

describe('linking a spawn to its child', () => {
  it('pairs on the description the parent sent and the child reported', () => {
    const steps = [step('s1', { detail: 'Map the transcript' })];
    expect(linkChildToStep(steps, 'Map the transcript')).toBe('s1');
  });

  it('ignores a step that already owns a child', () => {
    const steps = [step('s1', { detail: 'Same words', subagentId: 'child-a' }), step('s2', { detail: 'Same words' })];
    expect(linkChildToStep(steps, 'Same words')).toBe('s2');
  });

  it('pairs two identical descriptions in the order they were admitted', () => {
    const steps = [step('s1', { detail: 'Same words' }), step('s2', { detail: 'Same words' })];
    const first = linkChildToStep(steps, 'Same words');
    steps.find((candidate) => candidate.id === first)!.subagentId = 'child-a';
    expect(linkChildToStep(steps, 'Same words')).toBe('s2');
  });

  it('never pairs a step that is not a spawn', () => {
    expect(linkChildToStep([step('s1', { toolName: 'read', detail: 'Map the transcript' })], 'Map the transcript')).toBeUndefined();
  });

  it('returns nothing for a child the parent never announced', () => {
    expect(linkChildToStep([], 'Map the transcript')).toBeUndefined();
    expect(linkChildToStep([step('s1')], '')).toBeUndefined();
  });

  it('keeps only the children no step points at', () => {
    const children = [child('child-a'), child('child-b')];
    expect(unlinkedChildren(children, [step('s1', { subagentId: 'child-a' })])).toEqual([children[1]]);
  });
});

describe('reading a child', () => {
  it('names the kind of work its newest running tool is doing', () => {
    expect(childActivity(child('c', { tools: [{ id: 't', name: 'read_file', output: '', status: 'running' }] }))).toBe('Reading');
    expect(childActivity(child('c', { tools: [{ id: 't', name: 'grep', output: '', status: 'running' }] }))).toBe('Searching');
    expect(childActivity(child('c', { tools: [{ id: 't', name: 'mcp__thing', output: '', status: 'running' }] }))).toBe('Mcp  Thing');
    expect(childActivity(child('c', { tools: [{ id: 't', name: 'read_file', output: '', status: 'done' }] }))).toBeUndefined();
  });

  it('measures a child from the renderer-stamped times', () => {
    expect(childElapsedMs(child('c', { startedAt: 1_000, finishedAt: 3_500 }), 9_999)).toBe(2_500);
    expect(childElapsedMs(child('c', { startedAt: 1_000 }), 3_500)).toBe(2_500);
    expect(childElapsedMs(child('c'), 3_500)).toBeUndefined();
  });

  it('stands in for a spawn whose child has not registered yet', () => {
    const pending = childFromStep(step('s1', { detail: 'Map the transcript', subagentType: 'explore', startedAt: 10 }));
    expect(pending).toMatchObject({ id: 's1', kind: 'explore', description: 'Map the transcript', status: 'running' });
  });

  it('reads a settled spawn from the step when its child was never recorded', () => {
    expect(childFromStep(step('s1', { status: 'done', output: 'All clear' }))).toMatchObject({ status: 'done', summary: 'All clear' });
    expect(childFromStep(step('s1', { status: 'error', output: 'Broke' }))).toMatchObject({ status: 'error', summary: 'Broke' });
  });
});
