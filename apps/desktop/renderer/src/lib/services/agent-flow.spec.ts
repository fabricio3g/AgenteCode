import { describe, expect, it } from 'vitest';
import { isWebsiteBuildRequest, stoppedWarning } from '$lib/services/agent-flow';

it('enforces website files only for website build requests', () => {
  expect(isWebsiteBuildRequest('Build a landing page with HTML and CSS')).toBe(true);
  expect(isWebsiteBuildRequest('Create a website for my cafe')).toBe(true);
  expect(isWebsiteBuildRequest('Explain addition in JavaScript')).toBe(false);
  expect(isWebsiteBuildRequest('Create an HTML card for pricing')).toBe(false);
  expect(isWebsiteBuildRequest('Show a map of this archaeological site')).toBe(false);
});

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

  it('research path does not surface step-limit failure copy', () => {
    expect(stoppedWarning('iteration_limit', '', { research: true })).toBe('');
    expect(stoppedWarning('tool_limit', '', { research: true })).toBe('');
    expect(stoppedWarning('loop', '', { research: true })).toBe('');
    expect(stoppedWarning('timeout', '', { research: true })).toMatch(/sources retrieved/i);
  });
});
