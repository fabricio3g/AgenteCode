import { describe, expect, it } from 'vitest';
import type { ToolContext } from '$lib/services/agent-types';
import { handleCreateHtmlCard, handleCreateInfoCard } from '$lib/services/agent-tool-artifacts';
import { buildArtifactFromContext, INLINE_ARTIFACT_FILE } from '$lib/services/agent-artifact';
import { getAllArtifacts } from '$lib/services/artifact-registry';

function makeCtx(): ToolContext {
  return {
    chatId: 'c1',
    files: {},
    executionMode: 'sandbox',
    onArtifact: () => {}
  };
}

function ok(output: unknown, extra?: Record<string, unknown>) {
  return { success: true as const, output, ...extra };
}
function fail(error: string) {
  return { success: false as const, error };
}

describe('inline widgets (info_card / html_card)', () => {
  it('publishes a strict non-empty info card schema to models', () => {
    const definition = getAllArtifacts().find((entry) => entry.id === 'info_card')?.toolDefinition;
    const rows = definition?.function.parameters.properties.rows;
    expect(definition?.function.parameters.additionalProperties).toBe(false);
    expect(rows?.minItems).toBe(1);
    expect(rows?.items?.required).toEqual(['label', 'value']);
  });

  it('writes info_card inline artifact parseable for chat preview', () => {
    const ctx = makeCtx();
    const result = handleCreateInfoCard({
      args: {
        title: 'Madrid weather',
        subtitle: 'As of search results',
        rows: [
          { label: 'Conditions', value: 'Partly cloudy' },
          { label: 'Temperature', value: '22°C' }
        ],
        footer: 'Source: [1]',
        accent: 'sky'
      },
      ctx,
      normPath: (v) => String(v || ''),
      ok,
      fail
    });

    expect(result.success).toBe(true);
    expect(ctx.files[INLINE_ARTIFACT_FILE]).toBeTruthy();
    const artifact = buildArtifactFromContext(ctx);
    expect(artifact?.inline?.kind).toBe('info_card');
    if (artifact?.inline?.kind === 'info_card') {
      expect(artifact.inline.title).toBe('Madrid weather');
      expect(artifact.inline.rows).toHaveLength(2);
      expect(artifact.inline.rows[1].value).toBe('22°C');
    }
  });

  it('sanitizes html_card remote scripts and stores kind', () => {
    const ctx = makeCtx();
    const result = handleCreateHtmlCard({
      args: {
        title: 'Snippet',
        html: '<div class="box">Hello</div><script>alert(1)</script><img src="https://evil.example/x.png"/>'
      },
      ctx,
      normPath: (v) => String(v || ''),
      ok,
      fail
    });

    expect(result.success).toBe(true);
    const raw = ctx.files[INLINE_ARTIFACT_FILE];
    const parsed = JSON.parse(raw);
    expect(parsed.kind).toBe('html_card');
    expect(parsed.html).toContain('Hello');
    expect(parsed.html).not.toContain('<script');
    expect(parsed.html).not.toMatch(/src=["']https?:/);
  });

  it('gracefully skips empty info card rows without failing the agent', () => {
    const ctx = makeCtx();
    const result = handleCreateInfoCard({
      args: { title: 'Empty', rows: [] },
      ctx,
      normPath: (v) => String(v || ''),
      ok,
      fail
    });
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ created: false, skipped: true });
    expect(ctx.files[INLINE_ARTIFACT_FILE]).toBeUndefined();
  });

  it('repairs common info card row shapes from model output', () => {
    const ctx = makeCtx();
    const result = handleCreateInfoCard({
      args: {
        title: 'Research facts',
        facts: {
          'Sources reviewed': 8,
          'Published range': '2021–2026'
        }
      },
      ctx,
      normPath: (v) => String(v || ''),
      ok,
      fail
    });

    expect(result.success).toBe(true);
    const artifact = buildArtifactFromContext(ctx);
    expect(artifact?.inline?.kind).toBe('info_card');
    if (artifact?.inline?.kind === 'info_card') {
      expect(artifact.inline.rows).toEqual([
        { label: 'Sources reviewed', value: '8' },
        { label: 'Published range', value: '2021–2026' }
      ]);
    }
  });
});
