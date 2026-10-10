import { describe, expect, it } from 'vitest';
import { compactStoredScene, resolveRoleplaySettings, roleplayReasoningLevel, sceneOverrides, sceneState } from './roleplay-settings';

describe('scene options as overrides', () => {
  const inherited = resolveRoleplaySettings({ interactionMode: 'narrative' });

  it('keeps only options that differ from what the scene inherits', () => {
    expect(sceneOverrides({ interactionMode: 'narrative', surprise: 40, characterIds: ['a'] }, inherited)).toEqual({ surprise: 40 });
  });

  it('separates scene state from options', () => {
    expect(sceneState({ characterIds: ['a'], journal: [], surprise: 40 })).toEqual({ characterIds: ['a'], journal: [] });
  });

  it('compacts scenes stored fully resolved, and leaves compact ones alone', () => {
    const full = { ...resolveRoleplaySettings({ surprise: 40 }), characterIds: ['a'] };
    expect(compactStoredScene(full)).toEqual({ characterIds: ['a'], surprise: 40 });
    const compact = { characterIds: ['a'], surprise: 40 };
    expect(compactStoredScene(compact)).toBe(compact);
    expect(compactStoredScene(null)).toBeNull();
  });
});

describe('roleplayReasoningLevel', () => {
  it('turns thinking off everywhere when the Settings toggle is off', () => {
    expect(roleplayReasoningLevel({ chatLevel: 'high', thinkingEnabled: false, local: false })).toBe('off');
    expect(roleplayReasoningLevel({ chatLevel: null, thinkingEnabled: false, local: true })).toBe('off');
  });

  it('defaults local roleplay to off, and cloud roleplay to the provider default', () => {
    expect(roleplayReasoningLevel({ chatLevel: null, thinkingEnabled: true, local: true })).toBe('off');
    expect(roleplayReasoningLevel({ chatLevel: null, thinkingEnabled: true, local: false })).toBeNull();
  });

  it("keeps a chat's own level when thinking is on", () => {
    expect(roleplayReasoningLevel({ chatLevel: 'medium', thinkingEnabled: true, local: true })).toBe('medium');
    expect(roleplayReasoningLevel({ chatLevel: 'low', thinkingEnabled: true, local: false })).toBe('low');
  });
});
