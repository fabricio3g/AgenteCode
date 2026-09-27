import { describe, expect, it } from 'vitest';
import { TWIST_VECTORS, pickTwist, twistInstruction } from './roleplay-twists';

/** Deterministic "random": walks the given values. */
function rolls(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe('pickTwist', () => {
  it('rolls a vector and an intensity', () => {
    const twist = pickTwist(rolls(0, 0));
    expect(twist.vector).toBe(TWIST_VECTORS[0]);
    expect(twist.intensity).toBe('mild');
  });

  it('clamps a stray roll instead of picking off the end', () => {
    expect(pickTwist(rolls(1, 1)).vector).toBe(TWIST_VECTORS[TWIST_VECTORS.length - 1]);
    expect(pickTwist(rolls(1, 1)).intensity).toBe('brutal');
    expect(pickTwist(rolls(0.999, 0.999)).intensity).toBe('brutal');
  });

  it('never returns an empty table entry', () => {
    for (let step = 0; step < 20; step += 1) {
      const twist = pickTwist(Math.random);
      expect(twist.vector.id).toBeTruthy();
      expect(['mild', 'sharp', 'brutal']).toContain(twist.intensity);
    }
  });

  it('falls back to the built-in table when handed an empty one', () => {
    expect(pickTwist(rolls(0, 0), []).vector).toBe(TWIST_VECTORS[0]);
  });

  it('uses a custom deck when the scene supplies one', () => {
    const deck = [{ id: 'audit', kind: 'pressure' as const, text: 'the guild audits the shop' }];
    expect(pickTwist(rolls(0, 2), deck).vector.id).toBe('audit');
  });
});

describe('twistInstruction', () => {
  const names = { char: 'Aiko', user: 'Sam' };

  it('names the vector and both characters', () => {
    const instruction = twistInstruction(pickTwist(rolls(0, 1)), names);
    expect(instruction).toContain(TWIST_VECTORS[0]!.text);
    expect(instruction).toContain('Aiko');
    expect(instruction).toContain('Sam');
  });

  it('frames the twist as consequence, not interruption', () => {
    // The line that keeps a twist from reading as something bolted on.
    const instruction = twistInstruction(pickTwist(rolls(0, 1)), names);
    expect(instruction).toContain('consequence of what just happened');
    expect(instruction).not.toContain('random');
  });

  it('leaves the trigger with the user, not the character', () => {
    const instruction = twistInstruction(pickTwist(rolls(0, 1)), names);
    expect(instruction).toContain('Sam did not cause it');
  });
});
