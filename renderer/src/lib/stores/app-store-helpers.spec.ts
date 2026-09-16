import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types/chat';
import { markAgentStopped, normalizeSessionComposerMode, reliableUsageMetadata } from '$lib/stores/app-store-helpers';

describe('normalizeSessionComposerMode', () => {
  it('preserves ask alongside chat and agent', () => {
    expect(normalizeSessionComposerMode('ask', 'home')).toBe('ask');
    expect(normalizeSessionComposerMode('agent', 'home')).toBe('agent');
    expect(normalizeSessionComposerMode('chat', 'home')).toBe('chat');
  });
});

describe('assistant runtime usage metadata', () => {
  it('uses llama.cpp completion tokens and generation speed instead of total wall time', () => {
    const metadata = reliableUsageMetadata({
      prompt_tokens: 137,
      completion_tokens: 276,
      total_tokens: 413,
      timings: {
        prompt_ms: 1200,
        predicted_ms: 5000,
        predicted_per_second: 55.2
      }
    }, 14.7, 'runtime');

    expect(metadata).toMatchObject({
      usageSource: 'runtime',
      inputTokens: 137,
      outputTokens: 276,
      totalTokens: 413,
      tokens: 276,
      timing: 5,
      modelTimingSeconds: 5,
      tokensPerSecond: 55.2,
      promptEvalTimingSeconds: 1.2
    });
  });

  it('does not label request wall time as model timing when runtime timings are absent', () => {
    const metadata = reliableUsageMetadata({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14
    }, 14.7, 'runtime');

    expect(metadata?.outputTokens).toBe(4);
    expect(metadata?.timing).toBeUndefined();
    expect(metadata?.modelTimingSeconds).toBeUndefined();
    expect(metadata?.tokensPerSecond).toBeUndefined();
  });
});

describe('stopped agent presentation', () => {
  it('removes a planning-only step when the run is stopped before tools start', () => {
    const message = {
      agentSteps: [{
        id: 'step-1',
        type: 'thinking',
        label: 'Planning',
        status: 'running',
        detail: 'Step 1 of 10'
      }]
    } as ChatMessage;

    markAgentStopped(message);

    expect(message.agentSteps).toEqual([]);
  });

  it('keeps completed tool work while marking the active step stopped', () => {
    const message = {
      agentSteps: [
        { id: 'step-1', type: 'tool', label: 'Search', status: 'done' },
        { id: 'step-2', type: 'thinking', label: 'Planning', status: 'running', detail: 'Step 2 of 10' }
      ]
    } as ChatMessage;

    markAgentStopped(message);

    expect(message.agentSteps).toMatchObject([
      { label: 'Search', status: 'done' },
      { label: 'Stopped', status: 'done', detail: 'Stopped by user' }
    ]);
  });
});
