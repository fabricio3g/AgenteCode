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

  it.each(['blue', '#123456', 'unknown', 42, {}])('ignores unsupported decorative accent %j without losing content', (accent) => {
    const content = { title: 'Facts', rows: [{ label: 'Country', value: 'Argentina' }] };
    expect(parseArtifactToolArgs('create_info_card', { ...content, accent })).toEqual({
      success: true, repaired: true, data: content
    });
  });

  it.each(['sky', 'green', 'amber', 'red', 'violet'])('preserves supported accent %s and normalizes casing', (accent) => {
    const content = { title: 'Facts', rows: [{ label: 'A', value: 'B' }], accent };
    expect(parseArtifactToolArgs('create_info_card', content)).toEqual({ success: true, repaired: false, data: content });
    expect(parseArtifactToolArgs('create_info_card', { ...content, accent: ` ${accent.toUpperCase()} ` })).toEqual({
      success: true, repaired: true, data: content
    });
  });

  it('still rejects missing content when the accent is invalid', () => {
    expect(parseArtifactToolArgs('create_info_card', { accent: 'blue' }).success).toBe(false);
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

/**
 * One realistic call per artifact tool, each carrying an extra key the model
 * plausibly volunteers alongside the schema (a caption, a summary, an axis
 * label). Under the previous `.strict()` schemas a single such key rejected the
 * whole call, so 12 of 13 artifact types failed in practice.
 */
const REALISTIC_CALLS: Record<string, Record<string, unknown>> = {
  create_report: { title: 'Q3 Report', content: '# Q3\n\nBody', summary: 'A short summary' },
  create_work_product: { title: 'Brief', sections: [{ heading: 'Intro', content: 'text' }], description: 'why' },
  create_document: { title: 'Letter', content: 'Dear team', format: 'docx' },
  create_spreadsheet: { title: 'Budget', sheets: [{ name: 'S1', rows: [['a', 'b']] }], caption: 'budget' },
  create_presentation: { title: 'Deck', slides: [{ title: 'One', bullets: ['a'] }], theme: 'light' },
  create_pdf: { title: 'Doc', content: 'Hello', page_size: 'A4' },
  create_chart: { title: 'Sales', chart_type: 'bar', labels: ['Q1'], datasets: [{ label: 'R', data: [1] }], x_axis: 'Quarter' },
  create_diagram: { title: 'Flow', mermaid_source: 'graph TD; A-->B;', diagram_type: 'flowchart', caption: 'flow' },
  create_map: { latitude: 40.4, longitude: -3.7, zoom: 10, description: 'Madrid' },
  create_dashboard: { title: 'KPIs', metrics: [{ label: 'Users', value: 120 }], summary: 'ok' },
  create_info_card: { title: 'Fact', rows: [{ label: 'A', value: 'B' }], source: 'https://x.test' },
  create_html_card: { title: 'Card', html: '<p>hi</p>', description: 'a card' },
  export_research_package: { title: 'Research', citations: [{ title: 'T', url: 'https://x.test' }], format: 'md' }
};

describe('artifact tool argument schemas', () => {
  it('covers every registered artifact tool', () => {
    const registered = getAllArtifacts().map((a) => a.toolName).sort();
    expect(Object.keys(REALISTIC_CALLS).sort()).toEqual(registered);
  });

  it('accepts a realistic call for every artifact type', () => {
    const failures = getAllArtifacts()
      .map((artifact) => ({
        tool: artifact.toolName,
        result: parseArtifactToolArgs(artifact.toolName, REALISTIC_CALLS[artifact.toolName])
      }))
      .filter(({ result }) => !result.success)
      .map(({ tool, result }) => `${tool}: ${(result as { error: string }).error}`);

    expect(failures).toEqual([]);
  });

  it('drops unknown keys rather than failing the call', () => {
    const parsed = parseArtifactToolArgs('create_chart', {
      title: 'Sales', chart_type: 'bar', labels: ['Q1'], datasets: [{ data: [1] }],
      x_axis: 'Quarter', legend_position: 'top'
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Dropped, not forwarded — handlers should never see keys they cannot use.
    expect(parsed.data).not.toHaveProperty('x_axis');
    expect(parsed.data).not.toHaveProperty('legend_position');
    expect(parsed.data.labels).toEqual(['Q1']);
  });

  it('still rejects calls that are genuinely unusable', () => {
    // Relaxing unknown keys must not mean accepting anything at all.
    expect(parseArtifactToolArgs('create_chart', { title: 'No data' }).success).toBe(false);
    expect(parseArtifactToolArgs('create_diagram', { title: 'No source' }).success).toBe(false);
    expect(parseArtifactToolArgs('create_presentation', { title: 'No slides' }).success).toBe(false);
    expect(parseArtifactToolArgs('create_html_card', { title: 'No html' }).success).toBe(false);
    expect(parseArtifactToolArgs('create_report', {}).success).toBe(false);
  });

  it('defaults the list fields that used to be mandatory', () => {
    const work = parseArtifactToolArgs('create_work_product', {
      title: 'Brief', sections: [{ heading: 'H', content: 'C' }]
    });
    expect(work.success).toBe(true);
    if (work.success) expect(work.data.formats).toEqual(['md']);

    const research = parseArtifactToolArgs('export_research_package', { title: 'R' });
    expect(research.success).toBe(true);
    if (research.success) expect(research.data.kinds).toEqual(['citations']);
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

  it('drops an unknown field, consistent with every other artifact tool', () => {
    const parsed = parseArtifactToolArgs('create_map', { place: 'Madrid', centre: [1, 2] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty('centre');
  });
});
