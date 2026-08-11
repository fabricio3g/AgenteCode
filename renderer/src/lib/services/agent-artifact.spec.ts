import { describe, expect, it } from 'vitest';
import type { ArtifactManifest } from '$lib/types/chat';
import { buildArtifactFromContext, buildScopedArtifact } from '$lib/services/agent-artifact';

function manifest(over: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return {
    schemaVersion: 1,
    kind: 'chart',
    presentation: 'inline',
    entryPath: 'chart.json',
    status: 'ready',
    ...over
  };
}

const CHART = JSON.stringify({ kind: 'chart', title: 'Revenue', chartType: 'bar', labels: ['a'], datasets: [{ label: 's', data: [1] }] });
const DIAGRAM = JSON.stringify({ kind: 'diagram', title: 'Flow', source: 'graph TD; A-->B;' });

describe('buildScopedArtifact', () => {
  it('scopes to the files one tool call created, ignoring the rest of the turn', () => {
    // The whole point: a turn that made a chart and then a diagram used to produce two
    // artifacts that were each "everything so far", and only the last one survived.
    const files = { 'chart.json': CHART, 'diagram.json': DIAGRAM };

    const chart = buildScopedArtifact(
      { files, artifactManifest: null },
      { createdFiles: ['chart.json'], artifactManifest: manifest() }
    );
    const diagram = buildScopedArtifact(
      { files, artifactManifest: null },
      { createdFiles: ['diagram.json'], artifactManifest: manifest({ kind: 'diagram', entryPath: 'diagram.json' }) }
    );

    expect(Object.keys(chart?.files || {})).toEqual(['chart.json']);
    expect(chart?.inline?.kind).toBe('chart');
    expect(Object.keys(diagram?.files || {})).toEqual(['diagram.json']);
    expect(diagram?.inline?.kind).toBe('diagram');
  });

  it('carries the manifest through instead of re-inferring it', () => {
    /*
     * The headline artifact bug: the agent built artifacts without the manifest, so
     * inference took over — and because every generated document also writes a
     * `__preview__.html`, .docx/.xlsx/.pdf all resolved to `kind: 'web'` and rendered
     * in a bare iframe rather than their real viewer.
     */
    const artifact = buildScopedArtifact(
      { files: { 'report.docx': 'data:...', '__viewer__/report.docx.html': '<h1>R</h1>' }, artifactManifest: null },
      { createdFiles: ['report.docx'], artifactManifest: manifest({ kind: 'document', presentation: 'document', entryPath: 'report.docx' }) }
    );

    expect(artifact?.manifest?.kind).toBe('document');
    expect(artifact?.manifest?.presentation).toBe('document');
    // The viewer sibling has to come along or the document cannot be previewed.
    expect(artifact?.files['__viewer__/report.docx.html']).toBe('<h1>R</h1>');
  });

  it('returns null without a manifest or without created files', () => {
    expect(buildScopedArtifact({ files: { 'a.md': 'x' }, artifactManifest: null }, { createdFiles: ['a.md'] })).toBeNull();
    expect(buildScopedArtifact({ files: { 'a.md': 'x' }, artifactManifest: null }, { artifactManifest: manifest() })).toBeNull();
  });

  it('returns null when the created files are not in the context', () => {
    expect(buildScopedArtifact(
      { files: {}, artifactManifest: null },
      { createdFiles: ['gone.json'], artifactManifest: manifest({ entryPath: 'gone.json' }) }
    )).toBeNull();
  });

  it('only claims the work product when the manifest says it is one', () => {
    const workProduct = { id: 'wp', title: 'Deck', kind: 'presentation' as const, status: 'ready' as const, files: [], sourceIds: [], evidenceMap: {}, warnings: [], createdAt: 0 };

    const chart = buildScopedArtifact(
      { files: { 'chart.json': CHART }, workProduct, artifactManifest: null },
      { createdFiles: ['chart.json'], artifactManifest: manifest() }
    );
    // A chart created after a work product must not inherit it, or it resolves as a document.
    expect(chart?.workProduct).toBeNull();
    expect(chart?.manifest?.presentation).toBe('inline');

    const deck = buildScopedArtifact(
      { files: { 'deck.pptx': 'data:...' }, workProduct, artifactManifest: null },
      { createdFiles: ['deck.pptx'], artifactManifest: manifest({ kind: 'work_product', presentation: 'document', entryPath: 'deck.pptx' }) }
    );
    expect(deck?.workProduct?.title).toBe('Deck');
  });

  it('reports a repaired-arguments manifest as partial so the warning strip shows', () => {
    const artifact = buildScopedArtifact(
      { files: { 'chart.json': CHART }, artifactManifest: null },
      {
        createdFiles: ['chart.json'],
        artifactManifest: manifest({
          status: 'partial',
          issues: [{ code: 'artifact.arguments_repaired', severity: 'warning', message: 'normalized' }]
        })
      }
    );
    expect(artifact?.manifest?.status).toBe('partial');
    expect(artifact?.manifest?.issues?.[0].code).toBe('artifact.arguments_repaired');
  });
});

describe('buildArtifactFromContext', () => {
  it('still reads the legacy shared inline slot, for artifacts already in storage', () => {
    const artifact = buildArtifactFromContext({
      files: { 'chart.json': CHART, '__artifact__.json': CHART },
      artifactManifest: null
    });
    expect(artifact?.inline?.kind).toBe('chart');
  });

  it('rejects an inline payload whose kind is not renderable', () => {
    const artifact = buildArtifactFromContext({
      files: { 'thing.json': '{}', '__artifact__.json': JSON.stringify({ kind: 'hologram' }) },
      artifactManifest: null
    });
    expect(artifact?.inline).toBeNull();
  });
});
