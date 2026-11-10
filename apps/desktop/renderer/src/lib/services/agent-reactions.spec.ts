import { describe, expect, it, vi } from 'vitest';
import { createHomeTools } from './agent-home-tools';
import type { AgentRun } from './agent-run-context';

describe('agent reactions', () => {
  it('lets the model optionally choose one supported emoji for the turn', async () => {
    const onReaction = vi.fn(() => true);
    const run = { plan: { toolDefs: [] }, args: { onReaction } } as unknown as AgentRun;
    const tool = createHomeTools(run, true).tools.get('react_to_message');
    expect(tool).toBeDefined();
    expect(onReaction).not.toHaveBeenCalled();
    const execution = { signal: new AbortController().signal };
    expect((await tool!.execute('call', { emoji: '🎉' }, execution)).isError).toBeFalsy();
    expect(onReaction).toHaveBeenCalledWith('🎉');
    expect((await tool!.execute('call', { emoji: 'not emoji' }, execution)).isError).toBe(true);
    expect(onReaction).toHaveBeenCalledTimes(1);
  });
});
