import { describe, expect, it } from 'vitest';
import { resolveSpaceComposerMode, SPACE_IDS, SPACES } from './spaces';

describe('shared space composer policy', () => {
  it.each(SPACE_IDS)('%s starts with its declared default', (space) => {
    expect(resolveSpaceComposerMode(undefined, space)).toBe(SPACES[space].defaultComposerMode);
  });
  it.each(['code', 'roleplay', 'design'] as const)('%s preserves its mode regardless of a stored Home choice', (space) => {
    for (const mode of ['chat', 'instant', 'agent', 'ask']) {
      expect(resolveSpaceComposerMode(mode, space)).toBe(SPACES[space].defaultComposerMode);
    }
  });
  it('preserves Home choices and migrates legacy choices', () => {
    expect(resolveSpaceComposerMode('agent', 'home')).toBe('agent');
    expect(resolveSpaceComposerMode('instant', 'home')).toBe('instant');
    expect(resolveSpaceComposerMode('chat', 'home')).toBe('instant');
    expect(resolveSpaceComposerMode('ask', 'home')).toBe('instant');
  });
});
