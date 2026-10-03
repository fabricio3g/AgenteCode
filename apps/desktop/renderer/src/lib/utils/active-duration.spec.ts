import { describe, expect, it } from 'vitest';
import { ActiveDuration } from './active-duration';

describe('active duration', () => {
  it('continues from accumulated work without adding the paused interval', () => {
    const clock = new ActiveDuration();
    clock.resume(1000);
    clock.pause(61000);
    expect(clock.elapsed(600000)).toBe(60000);
    clock.resume(600000);
    expect(clock.elapsed(630000)).toBe(90000);
    clock.pause(630000);
    expect(clock.elapsed(900000)).toBe(90000);
  });
  it('does not restart on duplicate starts or count repeated stops', () => {
    const clock = new ActiveDuration();
    clock.resume(0); clock.resume(1000);
    clock.pause(2000); clock.pause(4000);
    expect(clock.elapsed(6000)).toBe(2000);
  });
});
