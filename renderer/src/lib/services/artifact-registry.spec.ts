import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_ICON_NAMES,
  getAllArtifacts,
  getArtifactDefinitionByToolName,
  parseArtifactToolArgs
} from './artifact-registry';
import { hasArtifactExecutor } from './agent-artifact-dispatch';

describe('artifact registry', () => {
  it('keeps ids, tool names, icons, schemas, and executors complete', () => {
    const artifacts = getAllArtifacts();
    expect(new Set(artifacts.map((artifact) => artifact.id)).size).toBe(artifacts.length);
    expect(new Set(artifacts.map((artifact) => artifact.toolName)).size).toBe(artifacts.length);
    for (const artifact of artifacts) {
      expect(ARTIFACT_ICON_NAMES).toContain(artifact.icon);
      expect(artifact.toolDefinition.function.name).toBe(artifact.toolName);
      expect(artifact.toolDefinition.function.parameters.type).toBe('object');
      expect(hasArtifactExecutor(artifact.toolName)).toBe(true);
      expect(getArtifactDefinitionByToolName(artifact.toolName)).toBe(artifact);
    }
  });

  it('repairs safe info-card variants before strict validation', () => {
    const parsed = parseArtifactToolArgs('create_info_card', {
      title: 'Facts',
      facts: { Sources: 4, Range: '2024–2026' }
    });
    expect(parsed).toEqual({
      success: true,
      repaired: true,
      data: {
        title: 'Facts',
        rows: [
          { label: 'Sources', value: '4' },
          { label: 'Range', value: '2024–2026' }
        ]
      }
    });
  });

  it('rejects missing semantic content with a targeted error', () => {
    const parsed = parseArtifactToolArgs('create_diagram', { title: 'Empty', mermaid_source: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error).toMatch(/mermaid_source/);
  });
});

describe('argument validation the model has to get past', () => {
  /*
   * All of these come from a real run. The model searched for a place, called
   * `create_map` with the coordinates, and was rejected three times with
   * "title: expected string, received undefined" — then flailed into
   * `create_info_card` and was rejected twice more. Nothing downstream ever needed
   * the title: `handleCreateMap` defaults it and ArtifactMap renders the heading
   * behind an `{#if}`. The schema alone was blocking it.
   */
  it('accepts a map with coordinates and no title', () => {
    const parsed = parseArtifactToolArgs('create_map', { latitude: -32.6167, longitude: -60.15, zoom: 12 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.title).toBeUndefined();
  });

  it('still accepts a map with a title', () => {
    const parsed = parseArtifactToolArgs('create_map', { title: 'Victoria', latitude: -32.6, longitude: -60.1 });
    expect(parsed.success).toBe(true);
  });

  it('reports a missing info card title as required, not as too short', () => {
    /*
     * `repairInfoCardArgs` used to emit `title: ''` when the model omitted it, which
     * turned a clear "required" into "Too small: expected string to have >=1
     * characters" — and the model retried the same call rather than adding a title.
     */
    const parsed = parseArtifactToolArgs('create_info_card', {
      rows: [{ label: 'Province', value: 'Entre Rios' }]
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error).not.toContain('Too small: expected string');
      expect(parsed.error).toMatch(/title/);
    }
  });

  it('tells the model which fields are required so a retry can succeed', () => {
    const parsed = parseArtifactToolArgs('create_info_card', {});
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error).toContain('Required: title, rows');
  });

  it('repairs the row containers a model actually reaches for', () => {
    // These shapes were already handled inside handleCreateInfoCard, but the schema
    // rejected them first, so the repair was unreachable from the real call path.
    for (const key of ['rows', 'items', 'facts', 'data', 'fields', 'details']) {
      const parsed = parseArtifactToolArgs('create_info_card', {
        title: 'Victoria, Entre Rios',
        [key]: [{ label: 'Population', value: '35000' }]
      });
      expect(parsed.success, key).toBe(true);
    }
  });

  it('repairs an object-of-facts into rows', () => {
    const parsed = parseArtifactToolArgs('create_info_card', {
      title: 'Victoria',
      facts: { Province: 'Entre Rios', Country: 'Argentina' }
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.rows).toEqual([
        { label: 'Province', value: 'Entre Rios' },
        { label: 'Country', value: 'Argentina' }
      ]);
    }
  });

  it('derives an info card title from a common alias', () => {
    const parsed = parseArtifactToolArgs('create_info_card', {
      heading: 'Victoria',
      rows: [{ label: 'Country', value: 'Argentina' }]
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.title).toBe('Victoria');
  });
});

describe('create_map accepts a place name', () => {
  it('takes a bare place with no coordinates', () => {
    const parsed = parseArtifactToolArgs('create_map', { place: 'Victoria, Entre Rios' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.place).toBe('Victoria, Entre Rios');
  });

  it('still takes coordinates with no place', () => {
    expect(parseArtifactToolArgs('create_map', { latitude: -32.6, longitude: -60.1 }).success).toBe(true);
  });

  it('takes both, and lets the handler prefer the explicit coordinates', () => {
    expect(parseArtifactToolArgs('create_map', {
      place: 'Madrid', latitude: 40.4, longitude: -3.7, zoom: 9
    }).success).toBe(true);
  });

  it('rejects an unknown field, so a typo is reported rather than ignored', () => {
    expect(parseArtifactToolArgs('create_map', { place: 'Madrid', centre: [1, 2] }).success).toBe(false);
  });
});
