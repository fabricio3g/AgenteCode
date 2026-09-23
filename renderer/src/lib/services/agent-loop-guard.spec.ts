import { describe, expect, it } from 'vitest';
import type { ToolCall } from './agent-types';
import { createExploreGuard, createLoopGuard } from './agent-loop-guard';

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: name, name, arguments: args });
const still = { sourceCount: 0, visibleFileCount: 0, draftChars: 0, observationCount: 0 };

describe('createLoopGuard', () => {
  it('stops the same call repeated three times while nothing progresses', () => {
    const guard = createLoopGuard({ localMode: false, isResearchChat: false });
    expect(guard.observe([call('calculator', { e: '((' })], still).stuckTool).toBeNull();
    expect(guard.observe([call('calculator', { e: '((' })], still).stuckTool).toBeNull();
    expect(guard.observe([call('calculator', { e: '((' })], still).stuckTool).toBe('calculator');
  });

  it('lets repeats through while the run is still making progress', () => {
    const guard = createLoopGuard({ localMode: false, isResearchChat: false });
    let verdict;
    for (let i = 0; i < 3; i++) {
      verdict = guard.observe([call('calculator', { e: '1+1' })], { ...still, observationCount: i });
    }
    expect(verdict).toEqual({ stuckTool: null, suppressed: 'calculator' });
  });

  it('catches a two-tool cycle, but not one of cheap read tools', () => {
    const cycle = createLoopGuard({ localMode: false, isResearchChat: false });
    let verdict;
    for (let i = 0; i < 6; i++) verdict = cycle.observe([call(i % 2 ? 'get_quote' : 'get_weather', { i })], still);
    expect(verdict?.stuckTool).toBe('get_weather ↔ get_quote');

    const reads = createLoopGuard({ localMode: false, isResearchChat: false });
    for (let i = 0; i < 6; i++) verdict = reads.observe([call(i % 2 ? 'read_file' : 'list_files', { i })], still);
    expect(verdict?.stuckTool).toBeNull();
  });

  it('local models trip the same-name guard sooner', () => {
    const local = createLoopGuard({ localMode: true, isResearchChat: false });
    let verdict;
    for (let i = 0; i < 4; i++) verdict = local.observe([call('get_weather', { city: i })], still);
    expect(verdict?.stuckTool).toBe('get_weather');
  });
});

describe('createExploreGuard', () => {
  it('nudges after a long browse-only streak, stops after a longer one, and resets on a write', () => {
    const guard = createExploreGuard();
    const reads = Array.from({ length: 8 }, () => call('read_file'));
    expect(guard.observe(reads)).toBe('nudge');
    expect(guard.observe([call('write_file')])).toBe('ok');
    expect(guard.streak).toBe(0);
    expect(guard.observe(Array.from({ length: 12 }, () => call('search_files')))).toBe('stop');
  });
});
