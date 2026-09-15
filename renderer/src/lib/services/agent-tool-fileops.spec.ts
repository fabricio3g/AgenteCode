import { describe, expect, it } from 'vitest';
import { handlePreviewProject } from '$lib/services/agent-tool-fileops';
import { buildPreviewHtml } from '$lib/services/agent-content';
import { buildScopedArtifact } from '$lib/services/agent-artifact';
import type { ToolResult } from '$lib/services/agent-types';

function ok(output: unknown, extra?: Record<string, unknown>): ToolResult {
  return { success: true, output, ...extra };
}

const SITE_HTML = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Lumina</h1><script src="script.js"></script></body></html>';

describe('preview_project artifact publishing', () => {
  it('publishes the built site as a scoped web artifact', () => {
    // Without the manifest the collector dropped the preview result and the
    // finished website was unreachable from the Home transcript.
    const files: Record<string, string> = {
      'index.html': SITE_HTML,
      'style.css': 'body { color: red; }',
      'script.js': 'console.log("hi");'
    };

    const result = handlePreviewProject({ args: {}, files, buildPreviewHtml, ok });

    expect(result.success).toBe(true);
    expect(files['__preview__.html']).toContain('<h1>Lumina</h1>');
    expect(result.createdFiles?.sort()).toEqual(['index.html', 'script.js', 'style.css']);
    expect(result.artifactManifest).toMatchObject({
      kind: 'web',
      presentation: 'web',
      entryPath: 'index.html',
      status: 'ready'
    });

    const artifact = buildScopedArtifact({ files, artifactManifest: null }, result);
    expect(artifact?.manifest?.kind).toBe('web');
    expect(artifact?.files['style.css']).toBeDefined();
  });

  it('honors an explicit entry point', () => {
    const files = {
      'about.html': '<html><body>About</body></html>',
      'index.html': '<html><body>Home</body></html>'
    };

    const result = handlePreviewProject({ args: { entryPoint: 'about.html' }, files, buildPreviewHtml, ok });

    expect(result.artifactManifest?.entryPath).toBe('about.html');
  });

  it('does not publish an artifact when no entry point can be built', () => {
    const files = { 'readme.txt': 'hello' };

    const result = handlePreviewProject({ args: {}, files, buildPreviewHtml, ok });

    expect(result.artifactManifest).toBeUndefined();
    expect(result.createdFiles).toBeUndefined();
  });
});
