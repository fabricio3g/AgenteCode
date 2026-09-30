import { describe, expect, it } from 'vitest';
import { compactStoredScene, resolveRoleplaySettings, sceneOverrides, sceneState } from './roleplay-settings';

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
