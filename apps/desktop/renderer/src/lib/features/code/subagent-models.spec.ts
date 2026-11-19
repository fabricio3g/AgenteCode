import { describe, expect, it } from 'vitest';
import { modelName, settledName, typedName } from './subagent-models';
import { childModelLabel } from './subagent-row';

describe('subagent model names', () => {
  it('builds a free name from the model id, like the runtime', () => {
    expect(modelName('qwen/qwen3-coder:free', [])).toBe('qwen3-coder-free');
    expect(modelName('GLM 5.1', [])).toBe('glm-5.1');
    expect(modelName('x/Scout', [{ name: 'scout' }])).toBe('scout-2');
    expect(modelName('main', [])).toBe('model');
  });

  it('folds what is typed instead of refusing it', () => {
    expect(typedName('Fast Reader')).toBe('fast-reader');
    expect(typedName('Revisor rápido!')).toBe('revisor-rapido-');
  });

  it('settles a name when the field is left: tidy, unique, never main', () => {
    const rows = [
      { name: 'scout', model: 'a/scout' },
      { name: '--scout--', model: 'b/other' },
      { name: 'main', model: 'c/x' },
      { name: '', model: 'z-ai/glm-5' },
      { name: '', model: '' }
    ];
    expect(settledName(rows, 0)).toBe('scout');
    expect(settledName(rows, 1)).toBe('scout-2');
    expect(settledName(rows, 2)).toBe('main-model');
    expect(settledName(rows, 3)).toBe('glm-5');
    expect(settledName(rows, 4)).toBe('');
  });

  it('labels a card by list name and model', () => {
    expect(childModelLabel({ model: 'qwen/qwen3-coder:free', seat: 'scout' })).toMatch(/^scout · /);
    expect(childModelLabel({ model: 'glm-5' })).not.toContain('·');
    expect(childModelLabel({ seat: 'scout' })).toBe('scout');
  });
});
