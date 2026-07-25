import { describe, expect, it } from 'vitest';
import { stoppedWarning } from '$lib/services/agent-flow';

describe('stoppedWarning', () => {
  const reasons: Array<Parameters<typeof stoppedWarning>[0]> = [
    'timeout',
    'loop',
    'tool_limit',
    'iteration_limit',
    'missing_artifacts',
    'error'
  ];

  for (const reason of reasons) {
    it(`uses human-readable copy for ${reason}`, () => {
      const text = stoppedWarning(reason, 'raw internal reason');
      expect(text.toLowerCase()).not.toContain('gathered evidence');
      expect(text.length).toBeGreaterThan(10);
    });
  }

  it('code/workspace tone stays plain', () => {
    const text = stoppedWarning('iteration_limit', '', { workspace: true });
    expect(text.toLowerCase()).not.toContain('gathered evidence');
    expect(text).toMatch(/partial|coding|continue/i);
  });
});
