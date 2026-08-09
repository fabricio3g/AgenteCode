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
