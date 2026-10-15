import { describe, expect, it } from 'vitest';
import { GenerationTimer, generationRate } from '$shared/generation-speed';
import { latestGenerationSpeed } from './generation-speed';
import type { ChatMessage } from '$lib/types/chat';

describe('generation speed', () => {
  it('measures only the output interval and resets between model calls', () => {
    const clock = new GenerationTimer();
    clock.record(10_000); clock.record(11_000);
    expect(generationRate(100, clock.duration(12_000))).toBe(50);
    clock.reset();
    clock.record(60_000); clock.record(61_000);
    expect(generationRate(100, clock.duration(62_000))).toBe(50);
  });
  it('hides speed for missing token counts, invalid time, and buffered responses', () => {
    const clock = new GenerationTimer();
    clock.record(1000); clock.record(1000);
    expect(clock.duration(2000)).toBeUndefined();
    for (const tokens of [undefined, 0, -10, NaN, Infinity]) expect(generationRate(tokens, 1000)).toBeUndefined();
    for (const duration of [undefined, 0, -10, NaN, Infinity]) expect(generationRate(100, duration)).toBeUndefined();
  });
  it('uses the selected reply version and ignores failed replies', () => {
    const messages = [
      { role:'assistant', metadata:{ tokensPerSecond:40 } },
      { role:'assistant', activeVersion:1, metadata:{ tokensPerSecond:20 }, versions:[{ metadata:{ tokensPerSecond:20 } }, { metadata:{ tokensPerSecond:50 } }] },
      { role:'user', metadata:{ tokensPerSecond:90 } },
      { role:'assistant', status:'error', metadata:{ tokensPerSecond:80 } }
    ] as ChatMessage[];
    expect(latestGenerationSpeed(messages)).toBe(50);
    expect(latestGenerationSpeed([])).toBeUndefined();
  });
});
