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

  it('renders a plain report request as inline markdown without creating artifacts', async () => {
    const ensureRequestedArtifactsFromEvidence = vi.fn().mockResolvedValue([]);
    const ctx: ToolContext = {
      chatId: 'chat-1',
      files: {},
      executionMode: 'sandbox',
      onArtifact: vi.fn()
    };
    const observations: ToolObservation[] = [
      { name: 'web_search', args: {}, success: true, summary: 'Pemphigus vulgaris is a rare autoimmune blistering disorder.' }
    ];

    const content = await buildStrictFallbackContent({
      prompt: 'Give me an extensive report on pemphigus vulgaris',
      reason: 'the tool budget was reached',
      ctx,
      observations,
      sources: [
        {
          title: 'Pemphigus vulgaris overview',
          url: 'https://example.com/pemphigus-overview',
          snippet: 'Pemphigus vulgaris is an autoimmune blistering disease affecting skin and mucosa.'
        },
        {
          title: 'Pemphigus treatment guideline',
          url: 'https://example.com/pemphigus-treatment',
          snippet: 'Treatment commonly includes systemic corticosteroids and rituximab in appropriate patients.'
        }
      ],
      ensureRequestedArtifactsFromEvidence,
      evidenceSources: (_observations, sources) => sources,
      missingRequestedArtifactExtensions: () => []
    });

    expect(ensureRequestedArtifactsFromEvidence).toHaveBeenCalledOnce();
    expect(ctx.files).toEqual({});
    expect(content).toContain('# Pemphigus vulgaris');
    expect(content).toContain('## Executive Summary');
    expect(content).toContain('## Treatment and Management');
    expect(content).toContain('Treatment commonly includes systemic corticosteroids and rituximab');
    expect(content).toContain('[2]');
    expect(content).toContain('## References');
    expect(content).not.toContain('What was completed:');
  });
});
