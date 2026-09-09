import { describe, expect, it } from 'vitest';
import type { ToolContext } from '$lib/services/agent-types';
import { handleCreateHtmlCard, handleCreateInfoCard } from '$lib/services/agent-tool-artifacts';
import type { ArtifactManifest } from '$lib/types/chat';
import { buildScopedArtifact } from '$lib/services/agent-artifact';
import { getAllArtifacts } from '$lib/services/artifact-registry';

function makeCtx(): ToolContext {
  return {
    chatId: 'c1',
    files: {},
    executionMode: 'sandbox',
  };
}

function ok(output: unknown, extra?: Record<string, unknown>) {
  return { success: true as const, output, ...extra };
}
function fail(error: string) {
  return { success: false as const, error };
}

/**
 * Stands in for what `dispatchArtifactTool` attaches in production. Inline payloads
 * live at their own path now rather than in a single shared `__artifact__.json`
 * slot, so the artifact is built from the tool's own `createdFiles`.
 */
function inlineManifest(entryPath: string): ArtifactManifest {
  return { schemaVersion: 1, kind: 'info_card', presentation: 'inline', entryPath, status: 'ready' };
}

function scoped(ctx: ToolContext, createdFiles: string[] | undefined, entryPath: string) {
  return buildScopedArtifact(
    { files: ctx.files, artifactManifest: null },
    { createdFiles, artifactManifest: inlineManifest(entryPath) }
  );
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
    expect(ctx.files['info-card.json']).toBeTruthy();
    const artifact = scoped(ctx, result.createdFiles, 'info-card.json');
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
    const raw = ctx.files['html-card.json'];
    const parsed = JSON.parse(raw);
    expect(parsed.kind).toBe('html_card');
    expect(parsed.html).toContain('Hello');
    expect(parsed.html).not.toContain('<script');
    expect(parsed.html).not.toMatch(/src=["']https?:/);
  });

  it('strips single-quoted handlers, svg vectors and javascript: urls', () => {
    const ctx = makeCtx();
    const result = handleCreateHtmlCard({
      args: {
        title: 'X',
        html: `<div onclick='alert(1)' onload=alert(2)>Hi</div><svg onload="alert(3)"><circle/></svg><a href="javascript:alert(4)">x</a><a href='javascript:alert(5)'>y</a>`
      },
      ctx,
      normPath: (v) => String(v || ''),
      ok,
      fail
    });

    expect(result.success).toBe(true);
    const parsed = JSON.parse(ctx.files['html-card.json']);
    expect(parsed.html).not.toMatch(/on\w+\s*=/i);
    expect(parsed.html).not.toContain('<svg');
    expect(parsed.html).not.toMatch(/javascript:/i);
    expect(parsed.html).toContain('Hi');
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
    expect(ctx.files['info-card.json']).toBeUndefined();
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
    const artifact = scoped(ctx, result.createdFiles, 'info-card.json');
    expect(artifact?.inline?.kind).toBe('info_card');
    if (artifact?.inline?.kind === 'info_card') {
      expect(artifact.inline.rows).toEqual([
        { label: 'Sources reviewed', value: '8' },
        { label: 'Published range', value: '2021–2026' }
      ]);
    }
  });
});
