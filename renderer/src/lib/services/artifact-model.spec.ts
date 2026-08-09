import { describe, expect, it } from 'vitest';
import type { AgentArtifact } from '$lib/types/chat';
import { normalizeArtifact, resolveArtifactPresentation, resolveArtifactPreview } from './artifact-model';
import { viewerPathFor } from '$lib/utils/artifact-files';

function artifact(patch: Partial<AgentArtifact> = {}): AgentArtifact {
  return { title: 'Example', files: { 'index.html': '<h1>Current</h1>' }, ...patch };
}

describe('artifact model', () => {
  it('normalizes legacy web artifacts without mutating their files', () => {
    const input = artifact();
    const normalized = normalizeArtifact(input);
    expect(normalized.manifest).toMatchObject({ schemaVersion: 1, kind: 'web', presentation: 'web', entryPath: 'index.html', status: 'ready' });
    expect(normalized.files).toEqual(input.files);
    expect(input.manifest).toBeUndefined();
  });

  it('prefers a manifest entry over stale legacy preview HTML', () => {
    const input = artifact({
      previewHtml: '<h1>Stale</h1>',
      manifest: { schemaVersion: 1, kind: 'web', presentation: 'web', entryPath: 'index.html', status: 'ready' }
    });
    expect(resolveArtifactPreview(input)).toMatchObject({ html: '<h1>Current</h1>', basePath: 'index.html', source: 'manifest' });
  });

  it('prefers the generated viewer for a declared binary entry', () => {
    const path = 'report.pdf';
    const viewer = viewerPathFor(path);
    const input = artifact({
      files: { [path]: 'data:application/pdf;base64,AA==', [viewer]: '<p>PDF preview</p>' },
      manifest: { schemaVersion: 1, kind: 'pdf', presentation: 'document', entryPath: path, status: 'ready' }
    });
    expect(resolveArtifactPreview(input)).toMatchObject({ html: '<p>PDF preview</p>', basePath: viewer, source: 'viewer' });
  });

  it('marks empty artifacts invalid with a structured issue', () => {
    const normalized = normalizeArtifact(artifact({ files: {}, previewHtml: null }));
    expect(normalized.manifest?.status).toBe('invalid');
    expect(normalized.manifest?.issues).toContainEqual(expect.objectContaining({ code: 'artifact.empty', severity: 'error' }));
  });

  it('preserves an executor-provided partial status', () => {
    const normalized = normalizeArtifact(artifact({
      manifest: {
        schemaVersion: 1,
        kind: 'web',
        presentation: 'web',
        entryPath: 'index.html',
        status: 'partial',
        issues: [{ code: 'artifact.repaired', severity: 'warning', message: 'A safe repair was applied.' }]
      }
    }));
    expect(normalized.manifest?.status).toBe('partial');
  });

  it('derives capabilities instead of persisting them', () => {
    const resolved = resolveArtifactPresentation(artifact({ files: { 'notes.md': '# Notes' }, previewHtml: null }));
    expect(resolved.manifest.presentation).toBe('document');
    expect(resolved.capabilities).toEqual({ preview: true, source: true, edit: true, download: true });
  });
});
