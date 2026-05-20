import { describe, expect, it, vi } from 'vitest';
import { buildStrictFallbackContent } from '$lib/services/agent-strict-fallback';
import type { ToolContext, ToolObservation } from '$lib/services/agent-types';

describe('agent-strict-fallback', () => {
  it('summarizes completed work and missing file types', async () => {
    const ensureRequestedArtifactsFromEvidence = vi.fn().mockResolvedValue(['brief.docx']);
    const ctx: ToolContext = {
      chatId: 'chat-1',
      files: {
        'brief.docx': 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,abc'
      },
      executionMode: 'sandbox',
      onArtifact: vi.fn()
    };
    const observations: ToolObservation[] = [
      { name: 'web_search', args: {}, success: true, summary: 'Found sources' }
    ];

    const content = await buildStrictFallbackContent({
      prompt: 'Create a docx and pdf brief',
      reason: 'the tool budget was reached',
      ctx,
      observations,
      sources: [{ title: 'Example', url: 'https://example.com', snippet: 'Snippet' }],
      ensureRequestedArtifactsFromEvidence,
      evidenceSources: (_observations, sources) => sources,
      missingRequestedArtifactExtensions: () => ['pdf']
    });

    expect(ensureRequestedArtifactsFromEvidence).toHaveBeenCalledOnce();
    expect(content).toContain('brief.docx');
    expect(content).toContain('missing requested file type');
    expect(content).toContain('pdf');
  });
});
