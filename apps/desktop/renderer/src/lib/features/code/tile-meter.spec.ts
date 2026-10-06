import { describe, expect, it } from 'vitest';
import { applyCodeAgentEvent, createCodeRunState } from './code-run';
import { meterMode, runMeterMode, STALLED_MS } from './tile-meter';

const CHAT = 'c';

/** A run with a tool call in flight and its last event at `lastEventAt`. */
function runningRun() {
  const run = createCodeRunState();
  applyCodeAgentEvent(run, { type: 'tool_start', chatId: CHAT, toolCallId: 't', toolName: 'edit', args: { path: 'a.ts' } });
  run.lastEventAt = 1_000;
  return run;
}

describe('run meter modes', () => {
  it('puts an answer owed above any work in flight', () => {
    const run = runningRun();
    expect(runMeterMode(run, true, 1_000)).toBe('attention');
    expect(runMeterMode(run, false, 1_000)).toBe('busy');
  });

  it('reads a retry as attention too: the engine is asking, not producing', () => {
    const run = runningRun();
    run.retrying = { attempt: 2, delayMs: 500 };
    expect(runMeterMode(run, false, 1_000)).toBe('attention');
  });

  it('never looks busy once the reader asked it to stop', () => {
    const run = runningRun();
    run.stopping = true;
    expect(runMeterMode(run, true, 1_000)).toBe('stopped');
  });

  it('drizzles when nothing has arrived for a beat, so a stalled tool looks stalled', () => {
    const run = runningRun();
    expect(runMeterMode(run, false, 1_000 + STALLED_MS - 1)).toBe('busy');
    expect(runMeterMode(run, false, 1_000 + STALLED_MS)).toBe('quiet');
  });

  it('is quiet when nothing is working, whoever is asking', () => {
    const idle = createCodeRunState();
    idle.lastEventAt = 1_000;
    expect(runMeterMode(idle, false, 1_000)).toBe('quiet');
  });
});

describe('meter modes without a run', () => {
  it('takes the caller at its word when it has no clock', () => {
    expect(meterMode({ attention: false, working: true })).toBe('busy');
  });

  it('keeps the same ladder: stopping, then attention, then work, then silence', () => {
    expect(meterMode({ attention: true, working: true, lastEventAt: 1_000, stopping: true }, 1_000)).toBe('stopped');
    expect(meterMode({ attention: true, working: true, lastEventAt: 1_000 }, 1_000)).toBe('attention');
    expect(meterMode({ attention: false, working: false, lastEventAt: 1_000 }, 1_000)).toBe('quiet');
    expect(meterMode({ attention: false, working: true, lastEventAt: 1_000 }, 1_000)).toBe('busy');
    expect(meterMode({ attention: false, working: true, lastEventAt: 1_000 }, 1_000 + STALLED_MS)).toBe('quiet');
  });
});
