import { describe, expect, it } from 'vitest';
import type { AgentArtifact } from '$lib/types/chat';
import {
  createArtifactDraft,
  createDraftFile,
  deleteDraftPath,
  isArtifactDraftDirty,
  renameDraftPath,
  updateDraftFile,
  validateArtifactPath
} from './artifact-draft';

const base: AgentArtifact = {
  title: 'Draft',
  files: { 'index.html': '<h1>Old</h1>', 'src/app.js': 'console.log(1)', '__artifact__.json': '{}' },
  manifest: { schemaVersion: 1, kind: 'web', presentation: 'web', entryPath: 'index.html', status: 'ready' }
};

describe('artifact draft operations', () => {
  it('keeps changes isolated until the caller saves the current snapshot', () => {
    const draft = createArtifactDraft(base);
    draft.current = updateDraftFile(draft.current, 'index.html', '<h1>New</h1>');
    expect(base.files['index.html']).toBe('<h1>Old</h1>');
    expect(isArtifactDraftDirty(draft)).toBe(true);
  });

  it('creates, renames, and deletes nested paths without touching metadata', () => {
    let current = createDraftFile(base, 'src/theme.css', ':root{}');
    current = renameDraftPath(current, 'src', 'assets');
    expect(current.files['assets/app.js']).toBe('console.log(1)');
    expect(current.files['assets/theme.css']).toBe(':root{}');
    expect(current.files['__artifact__.json']).toBe('{}');
    current = deleteDraftPath(current, 'assets');
    expect(Object.keys(current.files)).toEqual(expect.arrayContaining(['index.html', '__artifact__.json']));
  });

  it('remaps a manifest entry when its path is renamed', () => {
    const renamed = renameDraftPath(base, 'index.html', 'preview.html');
    expect(renamed.manifest?.entryPath).toBe('preview.html');
  });

  it('rejects reserved, traversal, and colliding paths', () => {
    expect(() => validateArtifactPath('../secret')).toThrow();
    expect(() => validateArtifactPath('__preview__.html')).toThrow();
    expect(() => createDraftFile(base, 'index.html')).toThrow(/already exists/);
    expect(() => renameDraftPath(base, 'src/app.js', 'index.html')).toThrow(/already exists/);
  });
});
