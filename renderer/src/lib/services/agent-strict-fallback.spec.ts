import { describe, expect, it, vi } from 'vitest';
import { buildStrictFallbackContent } from '$lib/services/agent-strict-fallback';
import type { ToolContext, ToolObservation } from '$lib/services/agent-types';

describe('agent-strict-fallback', () => {
  it('lists files and missing file types without fallback boilerplate', async () => {
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
    expect(content).toContain('## Missing Files');
    expect(content).toContain('.pdf');
    expect(content).not.toContain('Agent stopped because');
    expect(content).not.toContain('What was completed');
  });

  it('renders only gathered evidence and sources without report boilerplate', async () => {
    const ensureRequestedArtifactsFromEvidence = vi.fn().mockResolvedValue([]);
    const ctx: ToolContext = {
      chatId: 'chat-1',
      files: {},
      executionMode: 'sandbox',
      onArtifact: vi.fn()
    };
    const observations: ToolObservation[] = [
      {
        name: 'web_search',
        args: {},
        success: true,
        summary: 'Distributed solar microgrids improve site resilience by pairing local generation with battery storage and controllable loads.'
      }
    ];

    const content = await buildStrictFallbackContent({
      prompt: 'Give me an extensive report on distributed solar microgrids',
      reason: 'the tool budget was reached',
      ctx,
      observations,
      sources: [
        {
          title: 'Microgrid resilience overview',
          url: 'https://example.com/microgrid-resilience',
          snippet: 'Distributed solar microgrids can keep critical loads online during wider grid outages when paired with storage and controls.'
        },
        {
          title: 'Battery storage economics',
          url: 'https://example.com/storage-economics',
          snippet: 'Battery storage can shift midday solar generation into evening demand periods and reduce peak-grid purchases.'
        }
      ],
      ensureRequestedArtifactsFromEvidence,
      evidenceSources: (_observations, sources) => sources,
      missingRequestedArtifactExtensions: () => []
    });

    expect(ensureRequestedArtifactsFromEvidence).toHaveBeenCalledOnce();
    expect(ctx.files).toEqual({});
    expect(content).toContain('## Gathered Evidence');
    expect(content).toContain('Distributed solar microgrids improve site resilience');
    expect(content).toContain('Battery storage can shift midday solar generation');
    expect(content).toContain('[2]');
    expect(content).toContain('## Sources');
    expect(content).toContain('https://example.com/storage-economics');
    expect(content).not.toContain('# Distributed solar microgrids');
    expect(content).not.toContain('## Executive Summary');
    expect(content).not.toContain('## Key Findings');
    expect(content).not.toContain('## Recommended Next Verification');
    expect(content).not.toContain('## References');
    expect(content).not.toContain('Agent stopped because');
    expect(content).not.toContain('What was completed:');
  });
});
