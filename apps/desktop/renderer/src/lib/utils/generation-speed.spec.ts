import { describe, expect, it } from 'vitest';
import { GenerationTimer, RuntimeGenerationTimer, generationRate } from '$shared/generation-speed';
import type { RuntimeEvent } from '$shared/agente-protocol.gen';
import { latestGenerationSpeed } from './generation-speed';
import type { ChatMessage } from '$lib/types/chat';

describe('generation speed', () => {
  it('does not time cumulative progress heartbeats as new output', () => {
    const timer = new RuntimeGenerationTimer();
    timer.observe({ type: 'generation_progress', output_bytes: 50 } as RuntimeEvent, 1000);
    timer.observe({ type: 'generation_progress', output_bytes: 100 } as RuntimeEvent, 2000);
    timer.observe({ type: 'generation_progress', output_bytes: 100 } as RuntimeEvent, 8000);
    expect(timer.observe({ type: 'call_usage' } as RuntimeEvent, 9000)).toBe(1000);
    // A new request cannot inherit the preceding call's time.
    timer.observe({ type: 'assistant_delta', text: 'Buffered' } as RuntimeEvent, 20_000);
    expect(timer.observe({ type: 'call_usage' } as RuntimeEvent, 30_000)).toBeUndefined();
  });
  it('measures only the output interval and resets between model calls', () => {
    const clock = new GenerationTimer();
    clock.record(10_000); clock.record(11_000);
    expect(clock.duration()).toBe(1000);
    clock.reset();
    clock.record(60_000); clock.record(61_000);
    expect(clock.duration()).toBe(1000);
  });

  /* The `call_usage` report lands after the provider has closed the stream.
     Timing to it charged that pause to the model, so a short answer read as
     half its real speed — and short answers are most of them. */
  it('never extends the window to when the usage report arrives', () => {
    const clock = new GenerationTimer();
    clock.record(10_000);
    clock.record(11_000);
    // The report shows up three seconds later; the window is still one second.
    expect(clock.duration()).toBe(1000);
  });

  /* N tokens arrive across N-1 gaps — the first is already on screen when the
     clock starts. Dividing all N by the window overstates every short reply. */
  it('counts the tokens the window holds, not the whole reply', () => {
    expect(generationRate(100, 1000)).toBe(99);
  });

  /* Below the sample floor the noise is bigger than the measurement, and this
     number is an observation of one stream, never the model's own throughput. */
  it('stays quiet when the sample is too small to mean anything', () => {
    expect(generationRate(2, 1000)).toBeUndefined();
    expect(generationRate(7, 5000)).toBeUndefined();
    expect(generationRate(100, 200)).toBeUndefined();
  });

  it('hides speed for missing token counts, invalid time, and buffered responses', () => {
    const clock = new GenerationTimer();
    clock.record(1000); clock.record(1000);
    expect(clock.duration()).toBeUndefined();
    // One token spans no gap: any number here would be noise.
    for (const tokens of [undefined, 0, 1, 2, -10, NaN, Infinity]) expect(generationRate(tokens, 1000)).toBeUndefined();
    for (const duration of [undefined, 0, -10, 299, NaN, Infinity]) expect(generationRate(100, duration)).toBeUndefined();
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
    expect(latestGenerationSpeed([{ role: 'assistant', status: 'streaming', metadata: { tokensPerSecond: 40 }, versions: [{ metadata: {} }] }] as ChatMessage[])).toBe(40);
  });
});
