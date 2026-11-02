import { describe, expect, it, vi } from 'vitest';

const canvas = vi.hoisted(() => ({ chatId: 'design-a', references: [{ path: 'references/a.png' }], takeTurnContext: vi.fn(() => 'Selected hero in design A') }));
const files = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('$lib/features/design/design.svelte', () => ({ designStore: canvas }));
vi.mock('./design-references', () => ({ saveReferenceImages: files.save }));
vi.mock('./agent-home-runtime', () => ({ runHomeRuntime: vi.fn(async () => ({ content: 'Done' })) }));
vi.mock('./bridge', () => ({ invoke: vi.fn(async () => ({ ok: true, content: '' })) }));
import { captureDesignTurnContext, runDesignTask } from './agent-design-runtime';
import { runHomeRuntime } from './agent-home-runtime';
import { invoke } from './bridge';
import type { RunAgentTaskArgs } from './agent-types';

describe('Design turn context', () => {
  it('keeps selections, references, workspace and version ownership when navigation happens during preparation', async () => {
    let finish!: (paths: string[]) => void;
    files.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const context = captureDesignTurnContext('design-a');
    const pending = runDesignTask({ chatId: 'design-a', messages: [], rawPrompt: 'Build a hero', designContext: context } as unknown as RunAgentTaskArgs);
    canvas.chatId = 'design-b';
    canvas.references = [{ path: 'references/b.png' }];
    finish([]);
    await pending;
    const [args, space] = vi.mocked(runHomeRuntime).mock.calls[0];
    expect(args.chatId).toBe('design-a');
    expect(space!.systemPrompt).toContain('Selected hero in design A');
    expect(space!.systemPrompt).toContain('references/a.png');
    expect(space!.systemPrompt).not.toContain('references/b.png');
    await space!.finished!('completed');
    expect(invoke).toHaveBeenCalledWith('design_manage', expect.objectContaining({ chatId: 'design-a', action: 'snapshot' }));
  });
});
