import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceFromIndexResult,
  buildWorkspacePrompt,
  getWorkspaceExtension,
  isSupportedWorkspaceFile,
  recalculateWorkspace,
  shouldIgnoreWorkspacePath,
  trimWorkspaceText
} from '$lib/stores/app-store-workspace';

describe('app-store-workspace', () => {
  it('handles workspace path filtering and text trimming', () => {
    expect(shouldIgnoreWorkspacePath('project/node_modules/pkg/index.js')).toBe(true);
    expect(shouldIgnoreWorkspacePath('project/src/App.svelte')).toBe(false);
    expect(getWorkspaceExtension('project/src/App.svelte')).toBe('svelte');
    expect(isSupportedWorkspaceFile('project/src/App.svelte')).toBe(true);
    expect(isSupportedWorkspaceFile('project/assets/logo.png')).toBe(false);

    const trimmed = trimWorkspaceText(` ${'a'.repeat(120010)} `);
    expect(trimmed.endsWith('[truncated]')).toBe(true);
  });

  it('recalculates and formats workspace state', () => {
    const workspace = buildWorkspaceFromIndexResult({
      root_name: 'demo',
      root_path: 'D:/demo',
      file_count: 2,
      indexed_count: 1,
      skipped_count: 1,
      files: [
        { path: 'src/app.ts', name: 'app.ts', size: 10, type: 'ts', status: 'ready', doc_id: 'doc-1' },
        { path: 'assets/logo.png', name: 'logo.png', size: 20, type: 'png', status: 'skipped', reason: 'Unsupported file type' }
      ]
    }, 123);

    const recalculated = recalculateWorkspace(workspace);
    expect(recalculated.indexedCount).toBe(1);
    expect(recalculated.skippedCount).toBe(1);
    expect(buildWorkspacePrompt(recalculated)).toContain('src/app.ts');
  });
});
